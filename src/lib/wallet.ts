import { createWalletClient, custom, getAddress } from "viem";
import type { Address, EIP1193Provider } from "viem";
import "viem/window";

import { chain } from "./chain";

/** Remembers which wallet was used so a reload can reconnect without a prompt. */
const STORAGE_KEY = "sushiflush:wallet";

export type DiscoveredWallet = {
  rdns: string;
  name: string;
  icon?: string;
  provider: EIP1193Provider;
};

export type WalletState = {
  wallets: DiscoveredWallet[];
  status: "idle" | "connecting" | "connected";
  address?: Address;
  chainId?: number;
  error?: string;
};

type EIP6963AnnounceEvent = CustomEvent<{
  info: { uuid: string; name: string; icon: string; rdns: string };
  provider: EIP1193Provider;
}>;

let state: WalletState = { wallets: [], status: "idle" };
const listeners = new Set<(state: WalletState) => void>();

/**
 * Built through a helper so the client keeps its inferred account and chain
 * types — `WalletClient` on its own erases both and makes every write untyped.
 */
function makeWalletClient(provider: EIP1193Provider, address: Address) {
  return createWalletClient({ account: address, chain, transport: custom(provider) });
}

export type AppWalletClient = ReturnType<typeof makeWalletClient>;

let active: DiscoveredWallet | undefined;
let walletClient: AppWalletClient | undefined;

export function getWalletState(): WalletState {
  return state;
}

export function subscribeWallet(listener: (state: WalletState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

function setState(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

/**
 * The wallet client is only valid while a wallet is connected, so callers get
 * it through a getter rather than holding a stale reference across disconnects.
 */
export function getWalletClient(): AppWalletClient | undefined {
  return walletClient;
}

/**
 * EIP-6963 discovery. Wallets answer `requestProvider` synchronously during the
 * dispatch, but extensions that inject late can answer a frame or two later, so
 * the listener stays attached for the life of the page and only the initial
 * settle is awaited.
 */
export async function discoverWallets(): Promise<DiscoveredWallet[]> {
  const found = new Map<string, DiscoveredWallet>();

  window.addEventListener("eip6963:announceProvider", (event) => {
    const { info, provider } = (event as EIP6963AnnounceEvent).detail;
    found.set(info.rdns, { rdns: info.rdns, name: info.name, icon: info.icon, provider });
    setState({ wallets: [...found.values()] });
  });
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  await new Promise((resolve) => setTimeout(resolve, 100));

  // Fallback for wallets that only inject the legacy global.
  if (found.size === 0 && window.ethereum) {
    found.set("injected", {
      rdns: "injected",
      name: "Browser Wallet",
      provider: window.ethereum as EIP1193Provider,
    });
  }

  const wallets = [...found.values()];
  setState({ wallets });
  return wallets;
}

async function readChainId(provider: EIP1193Provider): Promise<number> {
  const hex = await provider.request({ method: "eth_chainId" });
  return Number(hex);
}

function attach(wallet: DiscoveredWallet, address: Address, chainId: number) {
  active = wallet;
  walletClient = makeWalletClient(wallet.provider, address);
  localStorage.setItem(STORAGE_KEY, wallet.rdns);
  setState({ status: "connected", address, chainId, error: undefined });
}

/** Prompts the wallet for accounts. Safe to call while already connected. */
export async function connect(rdns: string): Promise<void> {
  const wallet = state.wallets.find((w) => w.rdns === rdns);
  if (!wallet) return;

  setState({ status: "connecting", error: undefined });
  try {
    const accounts = (await wallet.provider.request({ method: "eth_requestAccounts" })) as Address[];
    const address = accounts[0];
    if (!address) throw new Error("Wallet returned no accounts.");

    listenTo(wallet);
    attach(wallet, getAddress(address), await readChainId(wallet.provider));
  } catch (error) {
    setState({ status: "idle", error: describeConnectError(error) });
  }
}

/**
 * Silent reconnect on page load: `eth_accounts` returns the already-authorised
 * accounts without showing a wallet popup, so a reload does not nag the user.
 */
export async function reconnect(): Promise<void> {
  const rdns = localStorage.getItem(STORAGE_KEY);
  const wallet = rdns ? state.wallets.find((w) => w.rdns === rdns) : undefined;
  if (!wallet) return;

  try {
    const accounts = (await wallet.provider.request({ method: "eth_accounts" })) as Address[];
    const address = accounts[0];
    if (!address) return;

    listenTo(wallet);
    attach(wallet, getAddress(address), await readChainId(wallet.provider));
  } catch {
    // A wallet that refuses a silent read is simply treated as disconnected.
    localStorage.removeItem(STORAGE_KEY);
  }
}

export function disconnect(): void {
  active = undefined;
  walletClient = undefined;
  localStorage.removeItem(STORAGE_KEY);
  setState({ status: "idle", address: undefined, chainId: undefined, error: undefined });
}

/** Asks the wallet to move to Sepolia; the `chainChanged` event does the rest. */
export async function switchToChain(): Promise<void> {
  if (!walletClient) return;
  try {
    await walletClient.switchChain({ id: chain.id });
  } catch (error) {
    setState({ error: describeConnectError(error) });
  }
}

const attached = new WeakSet<EIP1193Provider>();

/**
 * Wallet events are the only way to learn about account or network changes made
 * in the extension itself. Listeners are registered once per provider — the
 * same provider object survives connect/disconnect cycles.
 */
function listenTo(wallet: DiscoveredWallet) {
  if (attached.has(wallet.provider)) return;
  attached.add(wallet.provider);

  wallet.provider.on("accountsChanged", (accounts: readonly string[]) => {
    if (active?.rdns !== wallet.rdns) return;
    const next = accounts[0];
    // An empty list means the user revoked access from inside the wallet.
    if (!next) disconnect();
    else attach(wallet, getAddress(next), state.chainId ?? 0);
  });

  wallet.provider.on("chainChanged", (chainId: string) => {
    if (active?.rdns !== wallet.rdns) return;
    setState({ chainId: Number(chainId) });
  });
}

function describeConnectError(error: unknown): string {
  // EIP-1193 rejection, before viem gets a chance to wrap it.
  if (typeof error === "object" && error !== null && "code" in error && error.code === 4001) {
    return "Rejected in wallet.";
  }
  return error instanceof Error ? error.message : String(error);
}
