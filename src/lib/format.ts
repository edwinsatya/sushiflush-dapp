import { BaseError, ContractFunctionRevertedError, formatUnits, parseUnits, UserRejectedRequestError } from "viem";
import type { Address } from "viem";

import { TOKEN_DECIMALS } from "./contracts";

/** Em dash stands in for "not loaded yet" everywhere in the UI. */
export const EMPTY = "—";

export function formatAmount(value: bigint | undefined, maximumFractionDigits = 4): string {
  if (value === undefined) return EMPTY;
  return Number(formatUnits(value, TOKEN_DECIMALS)).toLocaleString(undefined, {
    maximumFractionDigits,
  });
}

export function shortAddress(address: Address): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function formatTimestamp(seconds: bigint | undefined): string {
  if (seconds === undefined || seconds === 0n) return EMPTY;
  return new Date(Number(seconds) * 1000).toLocaleString();
}

/**
 * Parses a user-typed amount into base units, or returns null when the input is
 * not a positive number. `parseUnits` happily accepts "" and "-1", so the guard
 * has to come first.
 */
export function parseAmount(input: string): bigint | null {
  const trimmed = input.trim();
  if (trimmed === "" || !/^\d*\.?\d*$/.test(trimmed)) return null;
  try {
    const value = parseUnits(trimmed, TOKEN_DECIMALS);
    return value > 0n ? value : null;
  } catch {
    return null;
  }
}

/** Full-precision string for "max" buttons — toLocaleString would round. */
export function toInputValue(value: bigint): string {
  return formatUnits(value, TOKEN_DECIMALS);
}

/** Compact "2h ago" for a list where exact clock times would be noise. */
export function formatRelative(seconds: number): string {
  const delta = Math.max(0, Date.now() / 1000 - seconds);
  if (delta < 60) return "just now";
  if (delta < 3_600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3_600)}h ago`;
  return `${Math.floor(delta / 86_400)}d ago`;
}

const SECONDS_PER_YEAR = 365 * 24 * 60 * 60;

/** Coarse "6d 22h" style countdown — minutes are noise at this range. */
export function formatDuration(seconds: number): string {
  if (seconds <= 0) return "ended";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Annualised rate at the current pool size: every staker shares one emission
 * stream, so the rate falls as more is staked. Undefined while the pool is
 * empty, where the figure would be infinite rather than merely large.
 */
export function annualRate(rewardRate: bigint | undefined, totalStaked: bigint | undefined): number | undefined {
  if (rewardRate === undefined || !totalStaked) return undefined;
  return (Number(rewardRate) * SECONDS_PER_YEAR) / Number(totalStaked);
}

export function formatPercent(fraction: number | undefined): string {
  if (fraction === undefined) return EMPTY;
  const percent = fraction * 100;
  return `${percent.toLocaleString(undefined, {
    maximumFractionDigits: percent >= 100 ? 0 : 2,
  })}%`;
}

/**
 * viem wraps the wallet's raw error in layers. Walk down to the interesting one
 * so the UI can show "InsufficientStake" instead of a stack of RPC noise.
 */
export function describeError(error: unknown): string {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) {
      return "Rejected in wallet.";
    }
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      // Custom errors (ZeroAmount, InsufficientStake, …) carry no message, so
      // the name is the only thing worth showing.
      return reverted.data?.errorName ?? reverted.shortMessage;
    }
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}
