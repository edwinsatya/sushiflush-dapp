import { formatUnits, type Address } from "viem";

import { chain, publicClient } from "./chain";
import { STAKING_ADDRESS, TOKEN_SYMBOL, staking, sushiFlush } from "./contracts";
import {
  EMPTY,
  annualRate,
  describeError,
  formatAmount,
  formatDuration,
  formatPercent,
  formatTimestamp,
  parseAmount,
  shortAddress,
  toInputValue,
} from "./format";
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

function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing element #${id}`);
  return node as T;
}

function text(id: string, value: string) {
  el(id).textContent = value;
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
  text("pos-staked", formatAmount(data.staked, 2));
  renderEarned();

  const share =
    data.staked !== undefined && data.totalStaked
      ? `${formatPercent(Number(data.staked) / Number(data.totalStaked))} of the pool`
      : "";
  text("pos-share", share);

  const usable = ready() && !busy;
  el<HTMLButtonElement>("reward-claim").disabled = !usable || !data.earned;
  el<HTMLButtonElement>("reward-exit").disabled = !usable || !data.staked;
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
      : `${TOKEN_SYMBOL}/s · ${formatAmount(data.rewardRate * 86_400n, 0)} per day`,
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
  text("amount-available-label", mode === "stake" ? "Balance" : "Staked");
  text("amount-available", available() === undefined ? EMPTY : formatAmount(available(), 2));

  const submit = el<HTMLButtonElement>("action-submit");
  submit.textContent = mode === "stake" ? "Stake" : "Withdraw";
  submit.disabled = !ready() || busy;
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

  if (staked === undefined || total === undefined) {
    for (const row of ["preview-staked", "preview-share", "preview-daily"]) {
      setPreviewRow(row, EMPTY, undefined);
    }
  } else {
    setPreviewRow(
      "preview-staked",
      formatAmount(staked, 2),
      next && formatAmount(next.staked, 2),
    );
    setPreviewRow("preview-share", shareText(staked, total), next && shareText(next.staked, next.total));
    setPreviewRow("preview-daily", dailyText(staked, total), next && dailyText(next.staked, next.total));
  }

  const ended = data.periodFinish !== undefined && Number(data.periodFinish) * 1000 <= Date.now();
  text("preview-note", ended ? "The reward period has ended — no new rewards accrue." : "");
}

function renderConnectors() {
  const box = el("wallet-connect");

  for (const found of wallet.wallets) {
    const id = `connect-${found.rdns}`;
    if (document.getElementById(id)) continue;

    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className =
      "flex items-center gap-2 rounded-lg bg-accent px-3.5 py-1.5 text-[13px] font-medium text-accent-ink transition-colors hover:bg-accent-hover";
    if (found.icon) {
      const img = document.createElement("img");
      img.src = found.icon;
      img.alt = "";
      img.className = "size-4 rounded-[3px]";
      button.append(img);
    }
    button.append(document.createTextNode(found.name));
    button.addEventListener("click", () => void connect(found.rdns));
    box.append(button);
  }
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
    return true;
  } catch (error) {
    setStatus("error", `${label} failed — ${describeError(error)}`);
    return false;
  } finally {
    busy = false;
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
  const amount = parseAmount(input.value);
  if (amount === null) {
    setStatus("error", "Enter an amount greater than zero");
    return;
  }
  const limit = available();
  if (limit !== undefined && amount > limit) {
    setStatus("error", mode === "stake" ? "Amount exceeds your balance" : "Amount exceeds your stake");
    return;
  }

  if (mode === "stake") {
    // The approval receipt is mined before this line, so the simulation inside
    // the stake sees the new allowance regardless of when the UI catches up.
    if (!(await ensureAllowance(amount))) return;
    if (await send("Stake", () => writeStaking({ functionName: "stake", args: [amount] }))) {
      input.value = "";
    }
    return;
  }

  if (await send("Withdrawal", () => writeStaking({ functionName: "withdraw", args: [amount] }))) {
    input.value = "";
  }
}

// ---------------------------------------------------------------- wiring

function setMode(next: Mode) {
  mode = next;
  el<HTMLInputElement>("amount").value = "";
  renderForm();
  renderPreview();
}

function bind() {
  el("wallet-disconnect").addEventListener("click", () => disconnect());
  el("network-switch").addEventListener("click", () => void switchToChain());

  el("tab-stake").addEventListener("click", () => setMode("stake"));
  el("tab-withdraw").addEventListener("click", () => setMode("withdraw"));

  el("action-form").addEventListener("submit", (e) => void onSubmit(e as SubmitEvent));
  el("amount-max").addEventListener("click", () => {
    const limit = available();
    if (limit === undefined) return;
    el<HTMLInputElement>("amount").value = toInputValue(limit);
    renderPreview();
  });

  el("amount").addEventListener("input", renderPreview);

  el("reward-claim").addEventListener("click", () => {
    if (!busy) void send("Claim", () => writeStaking({ functionName: "getReward" }));
  });
  el("reward-exit").addEventListener("click", () => {
    if (!busy) void send("Exit", () => writeStaking({ functionName: "exit" }));
  });
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
    renderConnectors();
    render();

    // Re-read only when the account or network actually moved; the store also
    // emits for connecting/error transitions, which change nothing on-chain.
    if (identityChanged) void refreshAccount().catch(() => {});
  });

  void refreshPool().catch(() => {});
  void discoverWallets()
    .then(() => reconnect())
    .finally(() => {
      discovered = true;
      renderConnectors();
      render();
    });

  setInterval(refreshAll, POLL_MS);
  setInterval(renderEarned, TICK_MS);
}
