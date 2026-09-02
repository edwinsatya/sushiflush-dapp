import type { Address } from "viem";

import { chain, publicClient } from "./chain";
import { STAKING_ADDRESS, staking, sushiFlush, TOKEN_SYMBOL } from "./contracts";
import {
  EMPTY,
  describeError,
  formatAmount,
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

/** `earned` grows every second on-chain, so it is polled rather than pushed. */
const POLL_MS = 5_000;

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
/** True while a write is in flight; every action button is disabled meanwhile. */
let busy = false;
/** Wallet discovery is asynchronous — "no wallet" is only true once it ends. */
let discovered = false;

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
    data = { ...data, walletBalance: undefined, staked: undefined, earned: undefined, allowance: undefined };
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
  renderStats();
  renderActions();
}

function renderWallet() {
  const account = el("wallet-account");
  const connectBox = el("wallet-connect");

  account.hidden = !connected();
  connectBox.hidden = connected();

  if (wallet.address) text("wallet-address", shortAddress(wallet.address));

  const error = el("wallet-error");
  error.hidden = !wallet.error;
  error.textContent = wallet.error ?? "";

  el("network-warning").hidden = !connected() || wallet.chainId === chain.id;
}

function renderStats() {
  text("stat-wallet", `${formatAmount(data.walletBalance, 2)} ${TOKEN_SYMBOL}`);
  text("stat-staked", `${formatAmount(data.staked, 2)} ${TOKEN_SYMBOL}`);
  text("reward-earned", formatAmount(data.earned, 6));

  // Pool share only means something once both numbers are known and non-zero.
  const share =
    data.staked !== undefined && data.totalStaked
      ? `${((Number(data.staked) / Number(data.totalStaked)) * 100).toFixed(1)}% of pool`
      : "";
  text("stat-staked-hint", share);

  text("stat-total-staked", `${formatAmount(data.totalStaked, 2)} ${TOKEN_SYMBOL}`);
  text("stat-reward-rate", formatAmount(data.rewardRate, 6));
  text("stat-remaining", `${formatAmount(data.remainingReward, 2)} ${TOKEN_SYMBOL}`);
  text("stat-period-ends", formatTimestamp(data.periodFinish));

  text("stake-available", data.walletBalance === undefined ? EMPTY : formatAmount(data.walletBalance, 4));
  text("withdraw-available", data.staked === undefined ? EMPTY : formatAmount(data.staked, 4));
}

function renderActions() {
  const usable = ready() && !busy;
  for (const id of ["stake-submit", "withdraw-submit", "reward-claim", "reward-exit"]) {
    el<HTMLButtonElement>(id).disabled = !usable;
  }
  el<HTMLButtonElement>("reward-claim").disabled = !usable || !data.earned;
  el<HTMLButtonElement>("reward-exit").disabled = !usable || !data.staked;
}

function renderConnectors() {
  const box = el("wallet-connect");
  el("wallet-empty").hidden = !discovered || wallet.wallets.length > 0;

  for (const found of wallet.wallets) {
    const id = `connect-${found.rdns}`;
    if (document.getElementById(id)) continue;

    const button = document.createElement("button");
    button.id = id;
    button.type = "button";
    button.className =
      "flex items-center gap-2 rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50 hover:bg-neutral-700 dark:bg-white dark:text-neutral-900 dark:hover:bg-neutral-200";
    if (found.icon) {
      const img = document.createElement("img");
      img.src = found.icon;
      img.alt = "";
      img.className = "size-4 rounded";
      button.append(img);
    }
    button.append(document.createTextNode(`Connect ${found.name}`));
    button.addEventListener("click", () => void connect(found.rdns));
    box.append(button);
  }
}

// ---------------------------------------------------------------- writes

function setStatus(message: string, hash?: `0x${string}`) {
  const box = el("tx-status");
  box.hidden = false;
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
  renderActions();
  try {
    setStatus(`${label}: confirm in your wallet…`);
    const { hash } = await request();

    setStatus(`${label}: waiting for confirmation…`, hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      setStatus(`${label} failed on-chain.`, hash);
      return false;
    }

    setStatus(`${label} confirmed.`, hash);
    return true;
  } catch (error) {
    setStatus(`${label} failed: ${describeError(error)}`);
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

function readAmount(inputId: string, available: bigint | undefined): bigint | null {
  const input = el<HTMLInputElement>(inputId);
  const amount = parseAmount(input.value);
  if (amount === null) {
    setStatus("Enter an amount greater than zero.");
    return null;
  }
  if (available !== undefined && amount > available) {
    setStatus("Amount is larger than the available balance.");
    return null;
  }
  return amount;
}

async function onStake(event: SubmitEvent) {
  event.preventDefault();
  const amount = readAmount("stake-amount", data.walletBalance);
  if (amount === null || busy) return;

  // The approval receipt is mined before this line, so the simulation inside
  // the stake sees the new allowance regardless of when the UI catches up.
  if (!(await ensureAllowance(amount))) return;
  const ok = await send("Stake", () => writeStaking({ functionName: "stake", args: [amount] }));
  if (ok) el<HTMLInputElement>("stake-amount").value = "";
}

async function onWithdraw(event: SubmitEvent) {
  event.preventDefault();
  const amount = readAmount("withdraw-amount", data.staked);
  if (amount === null || busy) return;

  const ok = await send("Withdraw", () => writeStaking({ functionName: "withdraw", args: [amount] }));
  if (ok) el<HTMLInputElement>("withdraw-amount").value = "";
}

// ---------------------------------------------------------------- wiring

function bind() {
  el("wallet-disconnect").addEventListener("click", () => disconnect());
  el("network-switch").addEventListener("click", () => void switchToChain());

  el("stake").addEventListener("submit", (e) => void onStake(e as SubmitEvent));
  el("withdraw").addEventListener("submit", (e) => void onWithdraw(e as SubmitEvent));

  el("stake-max").addEventListener("click", () => {
    if (data.walletBalance !== undefined) {
      el<HTMLInputElement>("stake-amount").value = toInputValue(data.walletBalance);
    }
  });
  el("withdraw-max").addEventListener("click", () => {
    if (data.staked !== undefined) {
      el<HTMLInputElement>("withdraw-amount").value = toInputValue(data.staked);
    }
  });

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
    });

  // A single timer for the whole page: `earned` accrues per second, and the
  // pool numbers move whenever anyone else stakes.
  setInterval(refreshAll, POLL_MS);
}
