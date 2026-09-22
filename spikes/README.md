# Testnet spikes

Small scripts that let a human verify Hyperliquid behaviour that the docs leave open, **on testnet only**, with their
own funded testnet key. They exercise this library's real code paths (typed-data builders, compiler, policy, signing,
request assembly).

## Safety

- Every write spike calls `setupTestnetSpike()`, which **refuses to run** unless the network is testnet
  (`HL_NETWORK` unset or `testnet`; the transport is created with `isTestnet: true` and its URL is checked) **and**
  `TESTNET_MAIN_PRIVATE_KEY` is set. There is no mainnet code path.
- Use a throwaway key that only ever held testnet funds. Never put a key in a file; pass it in the environment.
- Agents created by the spikes are short-lived and revoked at the end. Builder approvals made by spike 03 are revoked.
- `setReferrer` (spike 02) is **one-way** per account, so it only runs when you set `SPIKE_REFERRAL_CODE`.
- Approving an **unnamed** agent (spike 05) replaces the unnamed agent HL's web app uses, so it is opt-in
  (`SPIKE_INCLUDE_UNNAMED=1`).

## Run

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm build          # spikes import the built package by name
export TESTNET_MAIN_PRIVATE_KEY=0x...                           # funded TESTNET account

node spikes/01-approve-agent-valid-until.ts
node spikes/02-agent-permissions.ts                             # optional: SPIKE_REFERRAL_CODE=CODE
SPIKE_BUILDER_ADDRESS=0x... node spikes/03-builder-fee-approvals.ts   # optional: SPIKE_SKIP_LIMIT=1
SPIKE_BUILDER_ADDRESS=0x... node spikes/04-order-with-builder.ts      # optional: SPIKE_BUILDER_FEE=10
node spikes/05-default-agent-expiry.ts                          # optional: SPIKE_INCLUDE_UNNAMED=1

node spikes/ws-invalid-coin.ts                                  # read-only, no key needed
```

Node 24 runs the `.ts` files directly (type stripping). `pnpm typecheck` also typechecks this folder.

| Script | Writes? | What it checks |
|---|---|---|
| `01-approve-agent-valid-until.ts` | yes | Named agent + `valid_until`, read back via `extraAgents`; revoke via zero address |
| `02-agent-permissions.ts` | yes | Agent-signed `scheduleCancel`, `batchModify`, modify-by-cloid, optional `setReferrer` |
| `03-builder-fee-approvals.ts` | yes | `approveBuilderFee`, `maxBuilderFee`, error at the 10-approval limit, revoke |
| `04-order-with-builder.ts` | yes | Tiny resting post-only order with `builder`, policy check, `orderStatus` by cloid, cancel |
| `05-default-agent-expiry.ts` | yes | Default expiry of agents approved without `valid_until` |
| `ws-invalid-coin.ts` | no | Whether an invalid coin subscription drops the socket (see `FINDINGS.md`) |

Record results in `FINDINGS.md`.
