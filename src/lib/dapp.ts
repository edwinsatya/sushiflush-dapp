import { formatUnits, type Address } from "viem";

import { scanActivity, type ActivityEntry, type ActivityKind } from "./activity";
import { chain, publicClient } from "./chain";
import { STAKING_ADDRESS, TOKEN_SYMBOL, staking, sushiFlush } from "./contracts";
import {
  EMPTY,
  annualRate,
  describeError,
  formatAmount,
  formatDuration,
  formatPercent,
  formatRelative,
  formatTimestamp,
  parseAmount,
  shortAddress,
  toInputValue,
} from "./format";
import { bindTour, endTour, isTourActive, isTourSeen, startTour } from "./tour";
import {
  connect,
  disconnect,
  discoverWallets,
  getWalletClient,
  reconnect,
  subscribeWallet,
  switchToChain,
  type WalletState,
} from "./wallet";

/** How often chain state is re-read. */
const POLL_MS = 5_000;
/** How often the claimable figure is re-projected between those reads. */
const TICK_MS = 200;

type Mode = "stake" | "withdraw";

type Snapshot = {
  totalStaked?: bigint;
  rewardRate?: bigint;
  periodFinish?: bigint;
  remainingReward?: bigint;
  walletBalance?: bigint;
  staked?: bigint;
  earned?: bigint;
  allowance?: bigint;
};

let data: Snapshot = {};
let wallet: WalletState = { wallets: [], status: "idle" };
let mode: Mode = "stake";
/** True while a write is in flight; every action button is disabled meanwhile. */
let busy = false;
/** Wallet discovery is asynchronous — "no wallet" is only true once it ends. */
let discovered = false;
/** When `data.earned` was read, so the display can project forward from it. */
let earnedReadAt = 0;

/**
 * `exit()` unwinds the whole position from a single click with no amount to
 * type, and the wallet popup cannot say "this is all of it". So the button arms
 * first and states what it is about to do. Every other action either has a typed
 * amount or is free to undo, and a second dialog there would only be noise.
 */
let exitArmed: { staked: string; earned: string } | null = null;
let exitTimer: number | undefined;

type ActivityState = {
  status: "disconnected" | "loading" | "ready" | "error";
  entries: ActivityEntry[];
  /** Next block to walk back from, or null once history is exhausted. */
  cursor: bigint | null;
};

let activity: ActivityState = { status: "disconnected", entries: [], cursor: null };

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function text(id: string, value: string) {
  el(id).textContent = value;
}

/**
 * Like `text`, but briefly highlights a figure whose value moved. Only for
 * discrete figures — the claimable number ticks continuously, and flashing it
 * five times a second would be strobing, not feedback.
 */
function figure(id: string, value: string) {
  const node = el(id);
  const previous = node.textContent;
  if (previous === value) return;

  node.textContent = value;
  // Nothing "changed" when a placeholder is replaced by the first real read.
  if (previous === null || previous === "" || previous === EMPTY) return;

  node.classList.remove("value-changed");
  void node.offsetWidth; // Forces a reflow so the animation restarts.
  node.classList.add("value-changed");
}

function connected(): boolean {
  return wallet.status === "connected" && wallet.address !== undefined;
}

/** Account reads are only meaningful once the wallet is on the right chain. */
function ready(): boolean {
  return connected() && wallet.chainId === chain.id;
}

function requireWallet() {
  const client = getWalletClient();
  if (!client) throw new Error("Wallet is not connected.");
  return client;
}

/** What the active tab operates on: wallet balance to stake, stake to withdraw. */
function available(): bigint | undefined {
  return mode === "stake" ? data.walletBalance : data.staked;
}

// ---------------------------------------------------------------- reads

async function refreshPool() {
  // These run in one tick, so the multicall batcher folds them into a single
  // RPC round trip.
  const [totalStaked, rewardRate, periodFinish, remainingReward] = await Promise.all([
    publicClient.readContract({ ...staking, functionName: "totalStaked" }),
    publicClient.readContract({ ...staking, functionName: "rewardRate" }),
    publicClient.readContract({ ...staking, functionName: "periodFinish" }),
    publicClient.readContract({ ...staking, functionName: "remainingReward" }),
  ]);
  data = { ...data, totalStaked, rewardRate, periodFinish, remainingReward };
  render();
}

async function refreshAccount() {
  if (!ready()) {
    data = {
      ...data,
      walletBalance: undefined,
      staked: undefined,
      earned: undefined,
      allowance: undefined,
    };
    render();
    return;
  }

  const address = wallet.address as Address;
  const [walletBalance, staked, earned, allowance] = await Promise.all([
    publicClient.readContract({ ...sushiFlush, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ ...staking, functionName: "balanceOf", args: [address] }),
    publicClient.readContract({ ...staking, functionName: "earned", args: [address] }),
    publicClient.readContract({
      ...sushiFlush,
      functionName: "allowance",
      args: [address, STAKING_ADDRESS],
    }),
  ]);
  earnedReadAt = Date.now();
  data = { ...data, walletBalance, staked, earned, allowance };
  render();
}

function refreshAll() {
  // Reads are independent; one failing RPC should not blank the other half.
  void refreshPool().catch(() => {});
  void refreshAccount().catch(() => {});
}

// ---------------------------------------------------------------- render

function render() {
  renderWallet();
  renderPosition();
  renderPool();
  renderForm();
  renderPreview();
  renderActivity();
}

function renderWallet() {
  el("wallet-account").hidden = !connected();
  el("wallet-connect").hidden = connected();
  el("wallet-empty").hidden = !discovered || wallet.wallets.length > 0;

  if (wallet.address) text("wallet-address", shortAddress(wallet.address));

  const error = el("wallet-error");
  error.hidden = !wallet.error;
  error.textContent = wallet.error ?? "";

  el("network-warning").hidden = !connected() || wallet.chainId === chain.id;
}

/**
 * Rewards accrue per second on-chain, but they are only *read* every POLL_MS.
 * Between reads the figure is projected from the account's share of the
 * emission, then reconciled by the next read — a still number would look
 * broken next to a per-second rate.
 */
function accrualPerSecond(): number {
  if (!data.rewardRate || !data.totalStaked || !data.staked) return 0;
  return (
    Number(formatUnits(data.rewardRate, 18)) * (Number(data.staked) / Number(data.totalStaked))
  );
}

function renderEarned() {
  if (data.earned === undefined) {
    text("pos-earned", EMPTY);
    return;
  }

  const base = Number(formatUnits(data.earned, 18));
  // Emission stops at periodFinish, so the projection has to stop there too.
  const finish = data.periodFinish ? Number(data.periodFinish) * 1000 : Infinity;
  const elapsed = Math.max(0, Math.min(Date.now(), finish) - earnedReadAt) / 1000;

  text("pos-earned", (base + accrualPerSecond() * elapsed).toFixed(6));
}

function renderPosition() {
  figure("pos-wallet", formatAmount(data.walletBalance, 2));
  figure("pos-staked", formatAmount(data.staked, 2));
  renderEarned();

  const share =
    data.staked !== undefined && data.totalStaked
      ? `${formatPercent(Number(data.staked) / Number(data.totalStaked))} of the pool`
      : "";
  text("pos-staked-note", share);

  const usable = ready() && !busy;
  el<HTMLButtonElement>("reward-claim").disabled = !usable || !data.earned;
  renderExitButton();
}

const EXIT_IDLE =
  "rounded-lg px-3.5 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-sunken hover:text-ink disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-muted";
const EXIT_ARMED =
  "rounded-lg border border-accent px-3.5 py-1.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent hover:text-accent-ink disabled:opacity-35";

function renderExitButton() {
  const button = el<HTMLButtonElement>("reward-exit");
  button.disabled = !ready() || busy || !data.staked;

  if (exitArmed === null) {
    button.className = EXIT_IDLE;
    button.textContent = "Withdraw all & claim";
    return;
  }

  button.className = EXIT_ARMED;
  // Figures are frozen at arm time; the claimable one ticks, and a label that
  // changes while you read it is not a confirmation.
  button.textContent = `Confirm: withdraw ${exitArmed.staked} & claim ${exitArmed.earned}`;
}

function armExit() {
  exitArmed = {
    staked: formatAmount(data.staked, 2),
    earned: formatAmount(data.earned, 4),
  };
  window.clearTimeout(exitTimer);
  // Falls back to safe on its own, so an armed button is never left lying around.
  exitTimer = window.setTimeout(disarmExit, 6_000);
  renderExitButton();
}

function disarmExit() {
  if (exitArmed === null) return;
  exitArmed = null;
  window.clearTimeout(exitTimer);
  renderExitButton();
}

function renderPool() {
  text("pool-apr", formatPercent(annualRate(data.rewardRate, data.totalStaked)));
  text("pool-apr-sub", data.totalStaked ? "at current pool size" : "");

  text("pool-total", formatAmount(data.totalStaked, 2));
  text("pool-total-sub", TOKEN_SYMBOL);

  text("pool-emission", formatAmount(data.rewardRate, 6));
  text(
    "pool-emission-sub",
    data.rewardRate === undefined
      ? ""
      : `${TOKEN_SYMBOL}/s · ${formatAmount(data.rewardRate * 86_400n, 2)} per day`,
  );

  text("pool-remaining", formatAmount(data.remainingReward, 2));
  text("pool-remaining-sub", TOKEN_SYMBOL);

  text("pool-ends", formatTimestamp(data.periodFinish));
  text(
    "pool-ends-sub",
    data.periodFinish === undefined
      ? ""
      : formatDuration(Number(data.periodFinish) - Date.now() / 1000),
  );
}

const TAB_ACTIVE = "bg-surface text-ink shadow-sm";
const TAB_IDLE = "text-muted hover:text-ink";

function renderForm() {
  for (const tab of ["stake", "withdraw"] as const) {
    const button = el<HTMLButtonElement>(`tab-${tab}`);
    button.className = `rounded-[0.3125rem] px-4 py-1.5 text-[13px] font-medium transition-colors ${
      mode === tab ? TAB_ACTIVE : TAB_IDLE
    }`;
    button.setAttribute("aria-selected", String(mode === tab));
  }

  text("amount-label", mode === "stake" ? "Amount to stake" : "Amount to withdraw");
  renderAmountHint();

  const submit = el<HTMLButtonElement>("action-submit");
  submit.textContent = mode === "stake" ? "Stake" : "Withdraw";
  // An amount that cannot be submitted disables the button rather than failing
  // on click; the hint beside the label says why.
  submit.disabled = !ready() || busy || amountEntry().error !== null;

  // A transaction awaiting signature is already committed to an amount, so the
  // whole form locks — editing the field behind a pending wallet prompt only
  // creates a mismatch between what is on screen and what is being signed.
  el<HTMLInputElement>("amount").disabled = !ready() || busy;
  el<HTMLButtonElement>("amount-max").disabled = !ready() || busy;
  el<HTMLButtonElement>("tab-stake").disabled = busy;
  el<HTMLButtonElement>("tab-withdraw").disabled = busy;
  el("action-form").classList.toggle("opacity-60", busy);
}

/**
 * The field is `type="text"` so it can hold big decimal strings without the
 * quirks of `type="number"`, which means it accepts letters unless they are
 * filtered out. Commas are dropped rather than rejected, so a figure copied
 * from the page ("980,159.92") pastes cleanly.
 */
function sanitizeAmount(raw: string): string {
  const digits = raw.replace(/[^\d.]/g, "");
  const dot = digits.indexOf(".");
  if (dot === -1) return digits;
  return digits.slice(0, dot + 1) + digits.slice(dot + 1).replace(/\./g, "");
}

type AmountEntry = { amount: bigint | null; error: string | null };

/** Validates the field once, so the hint and the button agree on the reason. */
function amountEntry(): AmountEntry {
  const raw = el<HTMLInputElement>("amount").value.trim();
  if (raw === "") return { amount: null, error: "empty" };

  const amount = parseAmount(raw);
  if (amount === null) return { amount: null, error: "Enter a number greater than zero" };

  const limit = available();
  if (limit !== undefined && amount > limit) {
    return { amount, error: mode === "stake" ? "More than your balance" : "More than you staked" };
  }
  return { amount, error: null };
}

/**
 * Reports the consequence of the typed amount rather than restating the
 * balance, which is already a headline figure — the same number twice reads as
 * a duplicate, the remainder does not.
 */
function renderAmountHint() {
  const hint = el("amount-hint");
  const { amount, error } = amountEntry();

  if (error === "empty") {
    hint.textContent = "";
    return;
  }
  if (error !== null) {
    hint.textContent = error;
    hint.className = "figure text-[12px] text-accent";
    return;
  }

  const limit = available();
  hint.className = "figure text-[12px] text-faint";
  hint.textContent =
    limit === undefined || amount === null
      ? ""
      : `${formatAmount(limit - amount, 2)} ${mode === "stake" ? "left in wallet" : "still staked"}`;
}

/**
 * The amount in the field, applied to the current position — but only when it
 * is a valid, affordable number. A projection from an over-balance amount would
 * describe a transaction that cannot happen.
 */
function projection(): { staked: bigint; total: bigint } | undefined {
  if (data.staked === undefined || data.totalStaked === undefined) return undefined;

  const amount = parseAmount(el<HTMLInputElement>("amount").value);
  if (amount === null) return undefined;

  if (mode === "stake") {
    if (data.walletBalance !== undefined && amount > data.walletBalance) return undefined;
    return { staked: data.staked + amount, total: data.totalStaked + amount };
  }

  if (amount > data.staked) return undefined;
  return { staked: data.staked - amount, total: data.totalStaked - amount };
}

function shareText(staked: bigint, total: bigint): string {
  if (staked === 0n) return formatPercent(0);
  if (!total) return EMPTY;
  return formatPercent(Number(staked) / Number(total));
}

function dailyText(staked: bigint, total: bigint): string {
  if (data.rewardRate === undefined || staked === 0n || !total) return formatAmount(0n, 2);
  const perDay =
    Number(formatUnits(data.rewardRate * 86_400n, 18)) * (Number(staked) / Number(total));
  return perDay.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/** Renders `current → projected`, collapsing to just `current` when idle. */
function setPreviewRow(id: string, now: string, next: string | undefined) {
  const projecting = next !== undefined && next !== now;
  const nowEl = el(`${id}-now`);
  nowEl.textContent = now;
  nowEl.className = projecting ? "text-muted" : "";

  el(`${id}-arrow`).hidden = !projecting;
  const nextEl = el(`${id}-next`);
  nextEl.hidden = !projecting;
  nextEl.textContent = next ?? "";
}

function renderPreview() {
  const staked = data.staked;
  const total = data.totalStaked;
  const next = projection();
  const projecting = next !== undefined;

  // The band above already shows stake and pool share, so these rows only earn
  // their space once there is a before-and-after to compare.
  el("preview-row-staked").hidden = !projecting;
  el("preview-row-share").hidden = !projecting;
  text("preview-title", projecting ? "After this transaction" : "Your position");

  if (staked === undefined || total === undefined) {
    for (const row of ["preview-staked", "preview-share", "preview-daily"]) {
      setPreviewRow(row, EMPTY, undefined);
    }
  } else {
    setPreviewRow("preview-staked", formatAmount(staked, 2), next && formatAmount(next.staked, 2));
    setPreviewRow("preview-share", shareText(staked, total), next && shareText(next.staked, next.total));
    setPreviewRow("preview-daily", dailyText(staked, total), next && dailyText(next.staked, next.total));
  }

  const ended = data.periodFinish !== undefined && Number(data.periodFinish) * 1000 <= Date.now();
  text(
    "preview-note",
    ended
      ? "The reward period has ended — no new rewards accrue."
      : projecting
        ? ""
        : "Enter an amount to preview the change.",
  );
}

const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  Staked: "Staked",
  Withdrawn: "Withdrew",
  RewardPaid: "Claimed",
};

function setActivity(patch: Partial<ActivityState>) {
  activity = { ...activity, ...patch };
  renderActivity();
}

/**
 * Reloads from the chain head. `append` continues an existing walk instead,
 * which is what the "Load earlier" button does with the previous cursor.
 */
async function loadActivity(append = false) {
  if (!ready()) {
    setActivity({ status: "disconnected", entries: [], cursor: null });
    return;
  }

  const account = wallet.address as Address;
  const from = append ? activity.cursor : await publicClient.getBlockNumber();
  if (from === null) return;

  setActivity({ status: "loading" });
  try {
    const page = await scanActivity(account, from);
    // The wallet may have changed while the walk was in flight.
    if (wallet.address !== account) return;
    setActivity({
      status: "ready",
      entries: append ? [...activity.entries, ...page.entries] : page.entries,
      cursor: page.cursor,
    });
  } catch {
    setActivity({ status: "error" });
  }
}

function activityRow(entry: ActivityEntry): HTMLLIElement {
  const row = document.createElement("li");
  row.className = "flex items-baseline justify-between gap-4 py-3";

  const kind = document.createElement("span");
  kind.className = "text-[13px]";
  kind.textContent = ACTIVITY_LABEL[entry.kind];

  const right = document.createElement("span");
  right.className = "flex items-baseline gap-4";

  const amount = document.createElement("span");
  amount.className = "figure text-[14px]";
  amount.textContent = formatAmount(entry.amount, 4);

  const when = document.createElement("span");
  when.className = "w-16 text-right text-[12px] text-faint";
  when.textContent = entry.timestamp ? formatRelative(entry.timestamp) : EMPTY;

  const link = document.createElement("a");
  link.className = "text-[12px] text-faint underline underline-offset-4 hover:text-muted";
  link.href = `${chain.blockExplorers.default.url}/tx/${entry.hash}`;
  link.target = "_blank";
  link.rel = "noreferrer";
  link.textContent = "tx";

  right.append(amount, when, link);
  row.append(kind, right);
  return row;
}

function renderActivity() {
  const list = el("activity-list");
  const note = el("activity-note");
  const more = el<HTMLButtonElement>("activity-more");

  const hasEntries = activity.entries.length > 0;
  list.hidden = !hasEntries;
  list.replaceChildren(...activity.entries.map(activityRow));

  const NOTES: Record<ActivityState["status"], string> = {
    disconnected: connected()
      ? `Switch to ${chain.name} to see your activity.`
      : "Connect a wallet to see your activity.",
    // Only shown on a cold load; a refresh keeps the existing rows visible.
    loading: hasEntries ? "" : "Loading…",
    ready: hasEntries ? "" : "No staking activity for this account yet.",
    error: "Could not load activity from the RPC.",
  };
  note.textContent = NOTES[activity.status];
  note.hidden = note.textContent === "";

  // Offered only while there is history left to walk back through.
  more.hidden = activity.cursor === null || activity.status === "disconnected";
  more.disabled = activity.status === "loading";
}

/** Rebuild only when something the buttons display actually changed. */
let connectorsKey = "";

function renderConnectors() {
  const key = [wallet.wallets.map((w) => w.rdns).join(","), wallet.status, wallet.pending].join("|");
  if (key === connectorsKey) return;
  connectorsKey = key;

  const box = el("wallet-connect");
  const buttons = wallet.wallets.map((found) => {
    const connecting = wallet.pending === found.rdns;

    const button = document.createElement("button");
    button.id = `connect-${found.rdns}`;
    button.type = "button";
    // Any connection in flight owns the wallet popup, so the others would only
    // queue a second prompt behind it.
    button.disabled = wallet.status === "connecting";
    button.className =
      "flex items-center gap-2 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent-hover disabled:opacity-60 disabled:hover:bg-accent";

    if (connecting) {
      const spinner = document.createElement("span");
      spinner.className =
        "size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent";
      button.append(spinner, document.createTextNode("Check your wallet…"));
    } else {
      if (found.icon) {
        const img = document.createElement("img");
        img.src = found.icon;
        img.alt = "";
        img.className = "size-4 rounded-[3px]";
        button.append(img);
      }
      button.append(document.createTextNode(found.name));
    }

    button.addEventListener("click", () => void connect(found.rdns));
    return button;
  });

  box.replaceChildren(el("wallet-empty"), ...buttons);
}

// ---------------------------------------------------------------- writes

type StatusTone = "pending" | "success" | "error";

const TONE_DOT: Record<StatusTone, string> = {
  pending: "bg-muted",
  success: "bg-positive",
  error: "bg-accent",
};

function setStatus(tone: StatusTone, message: string, hash?: `0x${string}`) {
  el("tx-status").hidden = false;
  el("tx-status-dot").className = `size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`;
  text("tx-status-text", message);

  const link = el<HTMLAnchorElement>("tx-status-link");
  link.hidden = hash === undefined;
  if (hash) link.href = `${chain.blockExplorers.default.url}/tx/${hash}`;
}

/**
 * Every write goes through the same path: simulate first so a revert surfaces
 * as a named custom error before the wallet ever opens, then send, then wait
 * for the receipt and re-read. `busy` keeps a second write from racing the
 * first — the allowance and balances would be stale for it anyway.
 */
async function send(
  label: string,
  request: () => Promise<{ hash: `0x${string}` }>,
): Promise<boolean> {
  busy = true;
  render();
  try {
    setStatus("pending", `${label} — confirm in your wallet`);
    const { hash } = await request();

    setStatus("pending", `${label} — waiting for confirmation`, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      setStatus("error", `${label} failed on-chain`, hash);
      return false;
    }

    setStatus("success", `${label} confirmed`, hash);
    void loadActivity();
    return true;
  } catch (error) {
    setStatus("error", `${label} failed — ${describeError(error)}`);
    return false;
  } finally {
    busy = false;
    render();
    refreshAll();
  }
}

type StakingWrite =
  | { functionName: "stake"; args: [bigint] }
  | { functionName: "withdraw"; args: [bigint] }
  | { functionName: "getReward" }
  | { functionName: "exit" };

async function writeStaking(call: StakingWrite) {
  const client = requireWallet();
  const { request } = await publicClient.simulateContract({
    ...staking,
    ...call,
    account: client.account.address,
  });
  return { hash: await client.writeContract(request) };
}

/**
 * The staking contract pulls tokens with `transferFrom`, so a stake needs an
 * allowance at least as large as the amount. Approving exactly what is being
 * staked keeps no standing allowance behind after the transaction.
 */
async function ensureAllowance(amount: bigint): Promise<boolean> {
  if ((data.allowance ?? 0n) >= amount) return true;

  return send("Approval", async () => {
    const client = requireWallet();
    const { request } = await publicClient.simulateContract({
      ...sushiFlush,
      functionName: "approve",
      args: [STAKING_ADDRESS, amount],
      account: client.account.address,
    });
    return { hash: await client.writeContract(request) };
  });
}

async function onSubmit(event: SubmitEvent) {
  event.preventDefault();
  if (busy || !ready()) return;

  const input = el<HTMLInputElement>("amount");
  const { amount, error } = amountEntry();
  if (amount === null || error !== null) return;

  if (mode === "stake") {
    // The approval receipt is mined before this line, so the simulation inside
    // the stake sees the new allowance regardless of when the UI catches up.
    if (!(await ensureAllowance(amount))) return;
    if (await send("Stake", () => writeStaking({ functionName: "stake", args: [amount] }))) {
      input.value = "";
      renderForm();
      renderPreview();
    }
    return;
  }

  if (await send("Withdrawal", () => writeStaking({ functionName: "withdraw", args: [amount] }))) {
    input.value = "";
    renderForm();
    renderPreview();
  }
}

// ---------------------------------------------------------------- wiring

function setMode(next: Mode) {
  mode = next;
  el<HTMLInputElement>("amount").value = "";
  renderForm();
  renderPreview();
  renderActivity();
}

/**
 * Two walkthroughs, each shown once: how to connect, then what the connected
 * app can do. Completion is remembered, so this only fires on a first visit —
 * the Guide button reopens whichever one fits the current state.
 */
function maybeStartTour() {
  // Discovery has to finish first, or the connect step spotlights an empty slot.
  if (!discovered) return;

  if (ready() && !isTourSeen("features")) {
    // Connecting is exactly what the intro was asking for, so it counts as done.
    if (isTourActive()) endTour();
    startTour("features");
    return;
  }

  if (!connected() && !isTourActive() && !isTourSeen("intro")) {
    startTour("intro");
  }
}

function bind() {
  bindTour();
  el("tour-open").addEventListener("click", () => {
    if (!isTourActive()) startTour(ready() ? "features" : "intro");
  });

  el("wallet-disconnect").addEventListener("click", () => disconnect());
  el("network-switch").addEventListener("click", () => void switchToChain());

  el("tab-stake").addEventListener("click", () => setMode("stake"));
  el("tab-withdraw").addEventListener("click", () => setMode("withdraw"));

  el("action-form").addEventListener("submit", (e) => void onSubmit(e as SubmitEvent));
  el("amount-max").addEventListener("click", () => {
    const limit = available();
    if (limit === undefined) return;
    el<HTMLInputElement>("amount").value = toInputValue(limit);
    renderAmountHint();
    renderPreview();
    renderForm();
  });

  el("amount").addEventListener("input", () => {
    const input = el<HTMLInputElement>("amount");
    const cleaned = sanitizeAmount(input.value);
    if (cleaned !== input.value) {
      const caret = input.selectionStart ?? cleaned.length;
      const removed = input.value.length - cleaned.length;
      input.value = cleaned;
      // Keep the caret where the typing was, not flung to the end.
      const next = Math.max(0, caret - removed);
      input.setSelectionRange(next, next);
    }
    renderAmountHint();
    renderPreview();
    renderForm();
  });

  el("activity-more").addEventListener("click", () => void loadActivity(true));

  el("reward-claim").addEventListener("click", () => {
    if (!busy) void send("Claim", () => writeStaking({ functionName: "getReward" }));
  });
  el("reward-exit").addEventListener("click", () => {
    if (busy) return;
    if (exitArmed === null) {
      armExit();
      return;
    }
    disarmExit();
    void send("Exit", () => writeStaking({ functionName: "exit" }));
  });

  // Any other intent cancels a pending exit rather than leaving it armed.
  for (const id of ["reward-claim", "action-submit", "tab-stake", "tab-withdraw", "amount"]) {
    el(id).addEventListener("focusin", disarmExit);
    el(id).addEventListener("click", disarmExit);
  }
}

export function start() {
  bind();
  render();

  let previousAddress: Address | undefined;
  let previousChainId: number | undefined;

  subscribeWallet((next) => {
    const identityChanged = next.address !== previousAddress || next.chainId !== previousChainId;
    previousAddress = next.address;
    previousChainId = next.chainId;

    wallet = next;
    disarmExit();
    renderConnectors();
    render();

    // Re-read only when the account or network actually moved; the store also
    // emits for connecting/error transitions, which change nothing on-chain.
    if (identityChanged) {
      void refreshAccount().catch(() => {});
      void loadActivity();
    }

    maybeStartTour();
  });

  void refreshPool().catch(() => {});
  void discoverWallets()
    .then(() => reconnect())
    .finally(() => {
      discovered = true;
      renderConnectors();
      render();
      maybeStartTour();
    });

  setInterval(refreshAll, POLL_MS);
  setInterval(renderEarned, TICK_MS);
}
