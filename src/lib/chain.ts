import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

export const chain = sepolia;

/**
 * Read-only client, shared by every module. Pool statistics are plain
 * `eth_call` reads, so the page can render them before a wallet ever connects.
 *
 * `batch.multicall` collapses the reads that happen in the same tick into a
 * single Multicall3 call, which keeps the public Sepolia RPC from rate-limiting
 * us on every refresh.
 */
export const publicClient = createPublicClient({
  chain,
  // No URL: viem falls back to the chain's public RPC. Swap in an Alchemy
  // endpoint here if the public one rate-limits.
  transport: http(),
  batch: { multicall: true },
});
