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
