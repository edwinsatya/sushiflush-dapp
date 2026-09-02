import { sushiFlushAbi } from "./abi/sushiFlush";
import { sushiFlushStakingAbi } from "./abi/sushiFlushStaking";

/// Deployed on Sepolia. See the sushiflush-token repo.
export const SUSHIFLUSH_ADDRESS = "0xeB45F6b8Cbfe0B988a22a98C750CeFfe1f875b12" as const;
export const STAKING_ADDRESS = "0x9aBB85C136FE4F7bd827d7957f91D5A80C65c094" as const;

/**
 * Bundling address + abi together lets wagmi hooks spread one object:
 *   useReadContract({ ...sushiFlush, functionName: "balanceOf", args: [addr] })
 * and still infer argument and return types from the ABI.
 */
export const sushiFlush = {
  address: SUSHIFLUSH_ADDRESS,
  abi: sushiFlushAbi,
} as const;

export const staking = {
  address: STAKING_ADDRESS,
  abi: sushiFlushStakingAbi,
} as const;

/**
 * Block the staking contract was deployed in, read from the
 * `OwnershipTransferred` log its constructor emits. Event history never needs
 * to be scanned below this, which keeps the log walk short.
 */
export const STAKING_DEPLOY_BLOCK = 11_616_917n;

export const TOKEN_SYMBOL = "SFLUSH";
export const TOKEN_DECIMALS = 18;
