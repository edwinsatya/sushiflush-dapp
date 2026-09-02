# SushiFlush dApp

> **Testnet learning project.** The frontend for a personal Solidity/EVM learning
> project. Nothing here is audited, none of it is deployed to mainnet, and the
> token has no value.

A staking interface for [SushiFlush (SFLUSH)](https://github.com/edwinsatya/sushiflush-token)
on Sepolia: stake SFLUSH, watch rewards accrue, claim them, and read your history
back off-chain. Built with [Astro](https://astro.build/) and
[viem](https://viem.sh/) — **no UI framework**, no React, no wagmi.

## Contracts

| Contract | Address |
| --- | --- |
| `SushiFlush` | [`0xeB45F6b8Cbfe0B988a22a98C750CeFfe1f875b12`](https://sepolia.etherscan.io/address/0xeB45F6b8Cbfe0B988a22a98C750CeFfe1f875b12) |
| `SushiFlushStaking` | [`0x9aBB85C136FE4F7bd827d7957f91D5A80C65c094`](https://sepolia.etherscan.io/address/0x9aBB85C136FE4F7bd827d7957f91D5A80C65c094) |

Chain ID `11155111`. Addresses and ABIs live in [`src/lib/contracts.ts`](src/lib/contracts.ts)
and [`src/lib/abi/`](src/lib/abi/); the ABIs are generated from the contracts repo.

## What it does

| | |
| --- | --- |
| **Stake** | Approves the exact amount, then stakes it — two transactions only when the allowance is short |
| **Withdraw** | Takes back principal, leaving rewards unclaimed |
| **Claim** | `getReward()` — rewards only, stake untouched |
| **Withdraw all & claim** | `exit()` in a single transaction |
| **Live position** | Stake, pool share, and a claimable figure that ticks between polls |
| **Pool stats** | Annualised rate, total staked, emission per second and per day, rewards remaining this period, period end |
| **Projection** | As you type an amount, shows `current → after` for stake, share, and daily rewards |
| **Activity** | Your `Staked` / `Withdrawn` / `RewardPaid` history, read from event logs |

Owner-only functions (`notifyRewardAmount`, `transferOwnership`,
`renounceOwnership`) are deliberately absent. A reward-funding form on the same
page stakers use is how owner keys get phished; fund periods from the
[contracts repo's script](https://github.com/edwinsatya/sushiflush-token) instead.

## Stack

- **Astro 7** — static output, one HTML page
- **viem 2** — chain reads, wallet writes, ABI-derived types
- **Tailwind CSS 4** via `@tailwindcss/vite`
- **Inter Variable**, self-hosted through `@fontsource-variable/inter`
- TypeScript throughout, `astro/tsconfigs/strict`

Five runtime dependencies. Nothing is loaded from a CDN at runtime.

## Architecture

There is no UI framework. The page is static HTML built by Astro; one vanilla-TS
module boots in the browser and drives it by id.

```text
src/
├── pages/index.astro        # composes the page, imports the client module
├── layouts/Layout.astro     # <head>, fonts, favicons, theme-color
├── components/              # TopBar, PositionPanel, ActionPanel, PoolTable,
│                            #   StatRow, ActivityList — markup only, no logic
├── lib/
│   ├── chain.ts             # shared read-only client
│   ├── contracts.ts         # addresses, ABI bundles, deploy block
│   ├── wallet.ts            # EIP-6963 discovery, connect state, events
│   ├── activity.ts          # chunked event-log walk
│   ├── format.ts            # amounts, durations, rates, error unwrapping
│   ├── dapp.ts              # the controller: reads, renders, writes
│   └── abi/                 # generated from the contracts repo
└── styles/global.css        # design tokens, both themes
```

**Why no framework.** wagmi is React-bound, and Astro renders each island as its
own React root — sharing wallet state across islands means either one giant
island or a store outside React anyway. Since the whole app is one screen of
numbers and four buttons, the framework was carrying no weight. viem alone covers
the chain; the DOM work is a few hundred lines.

### Design notes

- **No hydration.** The page ships as HTML and the client module attaches to it.
  There is no framework runtime, no island boundary, no server-render of code
  that touches `window.ethereum`.
- **Reads are batched.** The public client enables `batch.multicall`, so the
  reads issued in one tick collapse into a single Multicall3 round trip instead
  of eight.
- **Writes simulate first.** Every write runs `simulateContract` before the
  wallet opens, so a revert surfaces as its custom error name
  (`InsufficientStake`, `ZeroAmount`) rather than an opaque wallet failure.
- **Approvals are exact.** Staking approves precisely the amount being staked, so
  no standing allowance survives the transaction.
- **Rewards are projected, then reconciled.** `earned()` is read every 5s but
  accrues every second, so the display extrapolates from the account's share of
  `rewardRate` and stops at `periodFinish`. Each poll corrects the drift.
- **Wallet discovery is EIP-6963**, with a `window.ethereum` fallback. The chosen
  wallet's `rdns` is the only thing persisted; reconnect uses `eth_accounts`, so
  a reload never triggers a popup.
- **Theming re-points variables, not utilities.** `global.css` defines semantic
  colours (`canvas`, `surface`, `ink`, `muted`, `accent`) in `@theme` and
  redefines them under `prefers-color-scheme: dark`. There is not one `dark:`
  variant in the app.

### Reading event history

The public RPC rejects `eth_getLogs` spans wider than **1000 blocks**
(`Request exceeds defined limit`), so [`activity.ts`](src/lib/activity.ts) walks
backwards in 1000-block chunks from the chain head, stopping when it has enough
entries, exhausts its chunk budget, or reaches the staking contract's deployment
block — recorded as `STAKING_DEPLOY_BLOCK` in `contracts.ts` and taken from the
`OwnershipTransferred` log its constructor emits. "Load earlier" continues the
walk from where it stopped.

Events are fetched unfiltered and matched to the connected account client-side
rather than issuing one indexed query per event type — a third of the requests,
and this contract's log volume makes the extra rows free. Logs carry a block
number but no timestamp, so the blocks behind the visible rows are fetched in
parallel and deduplicated.

## Usage

```shell
npm install
npm run dev      # localhost:4321
npm run check    # astro check — types across .astro and .ts
npm run build    # static output to ./dist
npm run preview  # serve the build
```

Requires Node.js 22.12+.

To use the app you need a browser wallet on Sepolia holding SFLUSH, plus a little
Sepolia ETH for gas.

## Configuration

Addresses live in [`src/lib/contracts.ts`](src/lib/contracts.ts). The RPC is set
in [`src/lib/chain.ts`](src/lib/chain.ts) and currently passes no URL, so viem
falls back to the chain's default public endpoint — for Sepolia that resolves to
`https://11155111.rpc.thirdweb.com`, a third party that is rate-limited and caps
log queries. For anything beyond testnet, pass your own endpoint:

```ts
transport: http("https://eth-sepolia.g.alchemy.com/v2/<key>"),
```

## Deployment

`npm run build` produces a static `./dist` — any static host will serve it.

[`public/_headers`](public/_headers) carries security headers in Netlify /
Cloudflare Pages format; other hosts need the equivalent. The important one is
`frame-ancestors 'none'`, since a wallet UI inside a hostile iframe is a drainer
pattern, and `frame-ancestors` is ignored in a `<meta>` tag by spec. A stricter
full CSP is included commented out — it needs verifying against the deployed page
first, because Astro may inline critical CSS and EIP-6963 wallets announce their
icons as `data:` URIs.

## Known limits

- **History depth is bounded by the RPC.** The 1000-block cap means deep history
  costs one request per 1000 blocks. Fine for a contract this young; an indexer
  would be the answer at scale.
- **Token metadata is hardcoded.** `TOKEN_SYMBOL` and `TOKEN_DECIMALS` are
  constants rather than contract reads. The token is a plain fixed-supply ERC-20
  with no upgrade path, so they cannot drift.
- **Injected wallets only.** No WalletConnect, so no mobile wallets over QR.
- **One chain.** Sepolia is hardcoded; the app asks the wallet to switch rather
  than supporting several.
