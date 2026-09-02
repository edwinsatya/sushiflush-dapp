import type { Address } from "viem";

import { publicClient } from "./chain";
import { STAKING_DEPLOY_BLOCK, staking } from "./contracts";

/**
 * The widest span the public RPC accepts for `eth_getLogs` — measured against
 * the endpoint, which rejects 1024 with "Request exceeds defined limit". Log
 * history therefore has to be walked in chunks rather than asked for at once.
 */
const CHUNK = 1_000n;

export type ActivityKind = "Staked" | "Withdrawn" | "RewardPaid";

export type ActivityEntry = {
  kind: ActivityKind;
  amount: bigint;
  blockNumber: bigint;
  hash: `0x${string}`;
  /** Orders entries inside a single block. */
  logIndex: number;
  /** Unix seconds; absent only if the block fetch failed. */
  timestamp?: number;
};

export type ActivityPage = {
  entries: ActivityEntry[];
  /** Block to continue from, or null once the walk reached deployment. */
  cursor: bigint | null;
};

function lower(value: string): string {
  return value.toLowerCase();
}

/**
 * Walks backwards from `before` in RPC-sized chunks, collecting the account's
 * events until it has `limit` of them, runs out of chunk budget, or reaches the
 * deployment block.
 *
 * Events are fetched unfiltered and matched client-side rather than with one
 * indexed query per event type: that is a third of the requests, and this
 * contract's log volume is low enough that the extra rows are free.
 */
export async function scanActivity(
  account: Address,
  before: bigint,
  { limit = 8, maxChunks = 12 } = {},
): Promise<ActivityPage> {
  const found: ActivityEntry[] = [];
  const target = lower(account);
  let to = before;
  let chunks = 0;

  while (to >= STAKING_DEPLOY_BLOCK && found.length < limit && chunks < maxChunks) {
    const from = to - CHUNK + 1n > STAKING_DEPLOY_BLOCK ? to - CHUNK + 1n : STAKING_DEPLOY_BLOCK;

    const logs = await publicClient.getContractEvents({
      ...staking,
      fromBlock: from,
      toBlock: to,
    });

    // Newest first within the chunk, so `limit` keeps the most recent.
    for (const log of [...logs].reverse()) {
      if (log.blockHash === null || log.transactionHash === null || log.logIndex === null) continue;

      let entry: ActivityEntry | undefined;
      if (log.eventName === "Staked" || log.eventName === "Withdrawn") {
        const { account: who, amount } = log.args;
        if (who && amount !== undefined && lower(who) === target) {
          entry = {
            kind: log.eventName,
            amount,
            blockNumber: log.blockNumber,
            hash: log.transactionHash,
            logIndex: log.logIndex,
          };
        }
      } else if (log.eventName === "RewardPaid") {
        const { account: who, reward } = log.args;
        if (who && reward !== undefined && lower(who) === target) {
          entry = {
            kind: "RewardPaid",
            amount: reward,
            blockNumber: log.blockNumber,
            hash: log.transactionHash,
            logIndex: log.logIndex,
          };
        }
      }

      if (entry) found.push(entry);
    }

    chunks += 1;
    if (from === STAKING_DEPLOY_BLOCK) {
      return { entries: await withTimestamps(found.slice(0, limit)), cursor: null };
    }
    to = from - 1n;
  }

  return { entries: await withTimestamps(found.slice(0, limit)), cursor: to };
}

/**
 * Logs carry a block number but no time, so the blocks behind the entries that
 * will actually be shown are fetched in parallel — at most `limit` of them, and
 * usually fewer since several entries often share a block.
 */
async function withTimestamps(entries: ActivityEntry[]): Promise<ActivityEntry[]> {
  const blocks = [...new Set(entries.map((entry) => entry.blockNumber))];

  const times = new Map<bigint, number>();
  await Promise.all(
    blocks.map(async (blockNumber) => {
      try {
        const block = await publicClient.getBlock({ blockNumber });
        times.set(blockNumber, Number(block.timestamp));
      } catch {
        // A missing timestamp degrades one row to no relative time; it must not
        // take down the whole list.
      }
    }),
  );

  return entries.map((entry) => ({ ...entry, timestamp: times.get(entry.blockNumber) }));
}
