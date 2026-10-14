# @kokoah/shared

Shared TypeScript library for **Kokoah**, a non-custodial trading app for Hyperliquid (HL) perpetual futures and spot.
The frontend, the signer frame, the backend and the signer service all import it, so they compute **identical numbers**
and produce **identical signed actions**.

It contains the HL network config and mainnet write guard, market/asset mapping, precision rules, risk formulas,
action-intent schemas, the intent → wire-action compiler, signing wrappers and EIP-712 builders, the signing policy,
error mapping and guardian (automation) rules.

- Version 0.1.0, `private: true` (not published). ESM only, TypeScript strict, built with `tsc` to `dist/`.
- **The library performs no network I/O.** It never calls `/info` or `/exchange`; callers do. (Only the scripts in
  `spikes/` talk to HL, and only to testnet.)
- Runtime dependencies: `@nktkas/hyperliquid@0.33.3` (exact), `viem`, `valibot`. Works in browsers and Node ≥ 22.12.

---

## Using it from another repo

```jsonc
// package.json of kokoah-frontend / kokoah-signer-frame / kokoah-backend / kokoah-signer-service
{
  "dependencies": {
    "@kokoah/shared": "link:../kokoah-shared"
  }
}
```

`dist/` is git-ignored. Build it once after cloning or pulling (`corepack pnpm build` in `kokoah-shared`); `link:`
consumers then see the new build immediately.

```ts
import { compileAction, evaluatePolicy } from "@kokoah/shared";          // everything
import { assessOrderRisk } from "@kokoah/shared/risk";                   // or per module
```

Subpath exports: `@kokoah/shared/network`, `/markets`, `/precision`, `/risk`, `/intents`, `/actions`, `/signing`,
`/policy`, `/errors`, `/guardians`.

## Commands

All commands go through corepack's pinned pnpm (`packageManager: pnpm@10.34.5`); no global installs.

```sh
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
corepack pnpm install            # uses pnpm-lock.yaml; CI uses --frozen-lockfile
corepack pnpm typecheck          # src + test (tsconfig.json) and spikes (tsconfig.spikes.json)
corepack pnpm test               # vitest; no network access
corepack pnpm build              # tsc -> dist/ (ESM + .d.ts + maps)
corepack pnpm check              # typecheck + test + build
```

## Safety notes

- **Testnet is the default everywhere.** `getNetworkConfig()` returns testnet; `parseNetworkName(env)` returns
  `"mainnet"` only for the exact string `mainnet`.
- **Mainnet write guard.** `assertWriteAllowed(config)` throws `MainnetWriteBlockedError` unless the config is testnet,
  or mainnet created with `getNetworkConfig("mainnet", { allowMainnetWrites: true })`. `buildExchangeRequest` and
  `prepareL1Request` (the only helpers that produce a sendable `/exchange` body) call it; `prepareL1Request` calls it
  **before** signing, and `buildExchangeRequest` refuses a user-signed action whose `hyperliquidChain` does not match
  the network.
- **Deny-by-default policy.** Agent keys can sign more than orders on HL (`vaultTransfer`, `createVault` with a
  10k USDC fee, `createSubAccount`, …). `evaluatePolicy` hard-denies every fund movement, vault/sub-account action,
  approval, referrer change, request-weight purchase, account-config change and TWAP, whatever the policy says.
- **Never ask a main wallet to sign an L1 action** (it would sign a blind hash). Main wallets only sign the readable
  user-signed typed data from `buildApproveAgent`, `buildApproveBuilderFee`, `buildWithdraw` and `buildPolicyTypedData`.
- **Validate coins before subscribing.** Confirmed on testnet (see `spikes/FINDINGS.md`): an invalid coin subscription
  silently kills the whole WebSocket. Use `registry.validateCoin(coin)`.
- Tests generate throwaway keys; golden vectors use public fake keys (`0x0123…`, `0xfedc…`). No secrets in the repo.

### Supply-chain hardening (`pnpm-workspace.yaml`, all documented pnpm 10.x settings)

| Setting | Value | Effect |
|---|---|---|
| `minimumReleaseAge` | `1440` | never install a version published less than 1 day ago (v10.16+) |
| `trustPolicy` | `no-downgrade` | fail if a package's publish trust evidence got weaker (v10.21+) |
| `blockExoticSubdeps` | `true` | transitive deps may not come from git/tarball URLs (v10.26+) |
| `strictDepBuilds` | `true` | an unreviewed dependency install script fails the install (scripts are blocked by default in pnpm 10; allow-list with `allowBuilds`) |
| `savePrefix` | `''` | `pnpm add` saves exact versions |

CI (`.github/workflows/ci.yml`) installs with `--frozen-lockfile` (pnpm's default when `CI=true`). No dependency
currently needs an install script.

---

## Modules

Units used throughout: `…Usd` USD, `…Rate` a fraction (0.00045 = 4.5 bps), `…Bps` basis points, `…Pct` percent
(9.2 = 9.2%). Prices and sizes on the wire are **decimal strings without trailing zeros**.

### `network`
`MAINNET`, `TESTNET`, `DEFAULT_NETWORK` (= testnet), `getNetworkConfig(name?, options?)`, `parseNetworkName(env)`,
`assertWriteAllowed(config)`, `isWriteAllowed`, `MainnetWriteBlockedError`, `NetworkConfig`
(`apiUrl`, `infoUrl`, `exchangeUrl`, `wsUrl`, `isTestnet`, `signatureSource` "a"/"b", `hyperliquidChain`,
`defaultSignatureChainId`, `allowMainnetWrites`).

```ts
const net = getNetworkConfig(parseNetworkName(process.env.HL_NETWORK)); // testnet unless HL_NETWORK=mainnet
assertWriteAllowed(net); // throws on mainnet unless allowMainnetWrites: true
```

### `markets`
Asset ids (`perpAssetId`, `spotAssetId`, `hip3AssetId`, `perpAssetIdForDex`, `outcomeAssetId`, `decodeAssetId`),
HIP-3 names (`parseCoin`, `formatHip3Coin`, `isHip3Coin`), display names (`WELL_KNOWN_MARKETS`,
`SPOT_TOKEN_DISPLAY_REMAP`, `normalizeCategory`) and `MarketRegistry`.

```ts
const registry = MarketRegistry.fromInfo({
  allPerpMetas: await info.allPerpMetas(),   // index i = perp dex i
  perpDexs: await info.perpDexs(),           // cross-checked against coin prefixes; mismatch throws
  spotMeta: await info.spotMeta(),           // optional
  annotations: await info.perpConciseAnnotations(), // optional: categories + display names
});
registry.require("xyz:SP500");  // { assetId: 110052, szDecimals: 3, maxLeverage: 50, marginTiers, marginMode,
                                //   onlyIsolated, displayName: "S&P 500", category: "indices", growthMode, … }
registry.validateCoin("xyz:NOTACOIN"); // { ok: false, reason: "unknown" } — do not subscribe
```

Delisted markets are excluded from `get`/`list` but keep their positional asset id (`getByAssetId`).
`validateCoin` reasons: `malformed`, `unknown`, `unknown_dex`, `delisted`, `dex_not_loaded`.

**Unparseable coin names** are real on HL testnet today (e.g. `VOLMEX:$EVIV`, `tndex:A B:C`), and they are skipped
rather than failing the whole registry:
- they reserve their positional id, so no other market's asset id shifts;
- they fail `validateCoin`;
- they are listed by `registry.skippedEntries()` (log them) and counted in `DexInfo.skippedMarkets`.

A market with invalid margin data (a max leverage or margin tier ≤ 0, or an empty margin table) is skipped the same
way, with reason `invalid_margin`, so one bad market never stops the others.

Structural inconsistencies still throw `MarketRegistryError`: a parseable coin on the wrong dex, or `perpDexs` that
doesn't line up with `allPerpMetas`. `fromInfo({ …, strict: true })` restores the 0.1.0 behaviour of throwing on any
bad name (and throws on invalid margin data too).

### `precision`
`formatPrice(price, szDecimals, kind)`, `roundPriceToTick(price, szDecimals, kind, "nearest" | "up" | "down")`,
`isValidPrice`, `checkPrice` (reason + suggestion), `priceTickAt`, `maxPriceDecimals`, `formatSize(size, szDecimals,
direction = "down")`, `isValidSize`, `sizeStep`, `validateOrderNotional(size, price)`, `MIN_ORDER_NOTIONAL_USD` (10),
`minOrderSize(price, szDecimals)`, `checkMinOrderNotional({ size, price, szDecimals, reduceOnly, positionSize })` (HL's
rule: $10 minimum, except a reduce-only order that closes the whole position; returns the valid size to suggest),
`normalizeDecimal`. Exact BigInt decimal arithmetic; numbers are first reduced to 15 significant digits.

```ts
isValidPrice("1234.5", 0);     // true      isValidPrice("1234.56", 0);   // false (6 sig figs)
isValidPrice("0.001234", 0);   // true      isValidPrice("0.0012345", 0); // false (7 decimals)
formatPrice(97123.456789, 0);  // "97123"   formatPrice(1.23456789, 5);   // "1.2"
checkPrice("1234.56", 0);      // { valid: false, reason: "too_many_significant_figures", suggestion: "1234.6" }
```

### `risk`
Margin tiers (`marginTiersFromTable`, `resolveMarginTiers`, `maintenanceSchedule`, `tierForNotional`,
`maintenanceMargin`, `maintenanceMarginRate`, `initialMargin`, `notional`), `liquidationPrice` (tier-aware HL formula),
`liquidationPriceFromMarginAvailable` (the literal formula), `liquidationDistancePct`, `unrealizedPnl`, `roePct`,
`estimateFees`, `builderFeeRate`, `tenthsBpsToPercentString`, `fundingCost`, `maxLossAtStop`, `rMultiple`,
`estimateMarketImpact`, `visibleDepthUsd`, and **`assessOrderRisk`**. Every formula cites its source in the code:

| Formula | Source |
|---|---|
| IM = size × price / leverage | HL "Margining" |
| MM = notional × rate(tier) − deduction(tier), rate = 1 / (2 × maxLeverage) | HL "Margin tiers" |
| liq = price − side × margin_available / size / (1 − l × side), l = 1/maintenance leverage at the tier at liq | HL "Liquidations" |
| uPnL = side × size × (mark − entry); ROE = uPnL / (size × entry / leverage) | FRONTEND_SPEC §23 |
| fee = notional × HL rate (+ notional × f / 100 000 builder) | FRONTEND_SPEC §23; HL "Builder codes" |
| funding/h = size × oracle × rate, positive ⇒ longs pay | HL "Funding" |
| loss at stop ≈ size × \|entry − stop\| + slippage (market, ≤10%) + exit fee | FRONTEND_SPEC §23; HL "TP/SL" |

```ts
const r = assessOrderRisk({
  market: { coin: "BTC", maxLeverage: 40, marginTiers: registry.require("BTC").marginTiers },
  side: "buy", size: 0.1, orderType: "market", markPrice: 100_000, leverage: 5, marginMode: "cross",
  account: { equityUsd: 10_000 },
  fees: { takerRate: 0.00045, makerRate: 0.00015, builderFeeTenthsBps: 25 },
  stopLoss: { triggerPrice: 98_000 },
  fundingRateHourly: 0.0000125,
});
r.liquidationPrice; r.fees.entry.hlFeeUsd; r.fees.entry.builderFeeUsd; r.stopLoss?.totalUsd; r.warnings; r.blocking;
```

Warning codes: `BELOW_MIN_NOTIONAL`, `INSUFFICIENT_MARGIN`, `LEVERAGE_ABOVE_MAX`, `CROSS_NOT_ALLOWED`,
`REDUCE_ONLY_WOULD_NOT_REDUCE`, `REDUCE_ONLY_EXCEEDS_POSITION`, `AT_OPEN_INTEREST_CAP`, `STOP_BEYOND_LIQUIDATION`,
`STOP_WRONG_SIDE`, `TAKE_PROFIT_WRONG_SIDE`, `NO_STOP_LOSS`, `LARGE_LOSS_AT_STOP`, `LIQUIDATION_NEAR`, `HIGH_LEVERAGE`,
`THIN_BOOK`, `BOOK_TOO_SHALLOW`, `EXTREME_FUNDING`, `PRICE_FAR_FROM_MARK`, `WEEKEND_PRICING`, `POSITION_INCREASE`,
`POSITION_FLIP`. Thresholds are in `DEFAULT_RISK_THRESHOLDS` and can be overridden per call.

### `intents`
Valibot schemas and types for `OrderIntent`, `CancelIntent`, `ModifyIntent`, `UpdateLeverageIntent`,
`UpdateIsolatedMarginIntent`, `ScheduleCancelIntent`, `NoopIntent` and the union `ActionIntent`
(`ActionIntentSchema`, `parseActionIntent`, `safeParseActionIntent`, `IntentValidationError`). Strict objects
(unknown keys rejected), decimals normalized, hex lowercased, cross-field rules enforced.

```ts
const intent = parseActionIntent({
  kind: "order", coin: "ETH", side: "buy", orderType: "limit", size: "0.5", price: "2500.5",
  takeProfit: { triggerPrice: "2700" }, stopLoss: { triggerPrice: "2400" }, origin: "manual",
});
```

### `actions`
`compileAction(intent, options)` → the exact HL wire action, using the SDK's own valibot schemas and `canonicalize` for
key order. `generateCloid(origin?)`, `deriveCloid(seed, origin?)`, `parseCloid`, `isCloid`, `marketOrderLimitPrice`,
`marketTriggerLimitPrice`, `CompileError`.

```ts
const compiled = compileAction(intent, {
  registry,
  builder: { address: KOKOAH_BUILDER, feeTenthsBps: 25 },     // builder: {b, f} on every order action
  getMidPrice: (coin) => mids[coin],                         // needed for market orders
});
compiled.action;       // { type: "order", orders: [parent, tp, sl], grouping: "normalTpsl", builder: {b, f} }
compiled.cloids;       // cloids of every order, parent first (0x + 32 lowercase hex, Kokoah-tagged)
compiled.vaultAddress; // for the request envelope, when the intent names a sub-account
```

Rules: market orders become IOC limits at mid ± slippage (default 100 bps, max 1000), rounded toward mid; attached
TP/SL become `normalTpsl` children (reduce-only, opposite side, same size); market-type triggers carry
`isMarket: true` and a limit price at trigger ± 10%, rounded toward the trigger (both prices step one tick further when
the tick is coarser than the tolerance, so the order stays marketable); `positionTpsl: true` gives grouping `positionTpsl`. Sizes and
prices must already be valid for the market — the compiler **rejects** (`SIZE_PRECISION` / `PRICE_PRECISION`, with the
rounded suggestion) rather than sign a different number than the intent shows.

Cloid layout: `0x6b6f` ("ko") + origin byte (01 manual, 02 guardian, 03 ai_ticket) + version 01 + 12 random bytes.

### `signing`
- L1 (agent key): `signL1Action`, `hashL1Action`, `l1TypedData`, `l1SigningDigest` (for KMS/HSM raw-digest signers),
  `recoverL1Signer`, `signatureToHex`, `signatureFromHex`.
- User-signed (main wallet): `buildApproveAgent` (named, `valid_until`, ≤ 180 days, name ≤ 16 chars),
  `buildRevokeAgent`, `buildApproveBuilderFee` (max 0.1%, 0 revokes), `buildWithdraw`, `buildSendAsset` (optional
  `fromSubAccount`), `buildSubAccountTransfer` (main account ⇄ sub-account in one readable `sendAsset`), `userSignedTypedData`,
  `userSignedDigest`, `signUserSignedAction`, `recoverUserSignedSigner`, `formatAgentName`, `parseAgentName`.
- Nonces: `NonceManager` interface, `MonotonicNonceManager` (`max(now, last + 1)` per key, clock offset, `observe`),
  `isNonceInWindow`.
- Requests: `buildExchangeRequest`, `prepareL1Request` (guarded), `expiresAfterFromNow`.

```ts
// Main wallet approves the device's agent key (browser, wagmi/viem):
const prepared = buildApproveAgent({ agentAddress, agentName: "kokoah-web", validUntil: now + 30 * DAY,
                                     nonce: now, network: net, signatureChainId: toHex(walletChainId) });
const signature = signatureFromHex(await walletClient.signTypedData(prepared.typedData));
const body = buildExchangeRequest({ network: net, action: prepared.action, nonce: prepared.nonce, signature });

// Signer frame, agent key:
const body2 = await prepareL1Request({ wallet: agentAccount, network: net, compiled, nonce: nonces.next(agentAddress),
                                       expiresAfter: expiresAfterFromNow(Date.now()) });
```

### `policy`
`PolicySchema`, `parsePolicy`, `evaluatePolicy(subject, context)`, `DENIED_ACTION_TYPES`,
`ALLOWLISTABLE_ACTION_TYPES`, presets `createManualTradingPolicy` / `createGuardianPolicy`, and signed policies:
`preparePolicySignature`, `buildPolicyTypedData`, `verifyPolicySignature`, `recoverPolicySigner`, `hashPolicy`,
`canonicalPolicyJson`, `policyTypedDataFields`, `summarizePolicy`.

Signed policies come in two typed-data formats, named by `authorization.typedDataVersion` (the EIP-712 domain version
of "Kokoah Policy", so the signature binds it). **Format 2** (`POLICY_EIP712_TYPES_V2`, `POLICY_TYPED_DATA_VERSION`)
shows every policy field in the wallet: lists sorted and comma-separated, `*` for all, `none` for none, `unlimited`
for a limit that isn't set; values that would read ambiguously (a comma, `*` or `none` in a list, the referral code
`none`) are refused. **Format 1** (`POLICY_EIP712_TYPES`, `typedDataVersion` omitted) is the original: sub-accounts,
origins, the daily loss limit, stop-loss exceptions, the reduce-only exemption, spot, the referral code and the
`expiresAfter` window are bound only through `policyHash`. New signatures use format 2 (`preparePolicySignature`
returns the authorization to send and the typed data to sign); format 1 signatures keep verifying. The policy, its
`version` (1) and its hash are the same in both. `policyTypedDataFields(version)` lists a format's fields in order with
the policy and authorization fields each one shows.

```ts
const decision = evaluatePolicy({ kind: "compiled", compiled, expiresAfter }, {
  policy, now: Date.now(), markPrices: { ETH: 3000 }, dailyNotionalUsedUsd, ordersInLastMinute, registry,
});
if (!decision.allowed) console.log(decision.violations); // [{ code: "STOP_LOSS_REQUIRED", message: "…" }, …]
```

Evaluate the **compiled** subject in signers and sign exactly `compiled.action`: the check covers both the intent
(origin) and the exact wire action (builder `{b, f}`, real prices, leverage). Evaluation **fails closed**: malformed
wire actions (non-string or non-positive sizes/prices, wrong types, unknown keys, unknown assets) are `INVALID_SUBJECT`.
Other rules:
- Reduce-only orders are exempt from notional caps by default (`exemptReduceOnlyFromNotionalCaps`) so protection and
  closes always work. Cancels are exempt from notional caps and the per-minute count, but not from `allowedCoins`.
- Price bands (`policy/band.ts`, also exported for UIs: `checkLimitPriceBand`, `checkTriggerPriceBand`): orders that
  execute now (market, IOC, and marketable limits: a buy at or above min(mark, mid), a sell at or below max(mark,
  mid)) must be within `priceBandPct` of mark. Resting, non-marketable GTC/ALO limits may sit up to
  `RESTING_PRICE_BAND_PCT` (50%) from mark, or `priceBandPct` if wider; this stops typos like 8500 for 85000. The mid is
  optional (`context.midPrices`) and must come from the evaluator's own market data. Not a signed field: signed
  policies are unchanged.
- Trigger orders are valued at `max(limit, trigger, mark)`. Their limit must be within max(`priceBandPct`, 10%) of the
  trigger; a trigger that has not fired yet may sit up to the resting band from mark; a trigger that would already
  fire at the current mark is price-banded against mark like an order that executes now.
- `requireStopLossForNewEntries`: an entry needs an attached stop covering its full size on the losing side (and within
  `maxStopLossDistancePct` of the entry, when set), or an existing exchange stop (`context.hasStopLoss`). Modifies of
  non-reduce-only orders need an existing stop, and are blocked by the daily loss lock like new entries.
- Always-place modifies (`a: true`) are refused when a builder is required (they would place orders without it).
- A wire subject's `origin` is self-declared; `allowedOrigins` is only meaningful for intents and compiled subjects
  built by the signer itself.
- Spot is denied unless the pair is in `allowedSpotCoins` (Convert's stablecoin pairs, `STABLECOIN_PAIRS`, and with
  spot trading the verified pairs, `VERIFIED_SPOT_PAIRS`; signers check both against the `spotMeta` they fetch with
  `verifiedSpotPairs`). Even then only one plain order: no modify, trigger, reduce-only or TP/SL grouping. Without
  `spotTrading` it must be IOC (Convert); with it, market orders and IOC, GTC and post-only limits within the price
  bands. Spot sells carry `requiredBuilder`; spot buys carry no builder (Hyperliquid charges builder fees on spot
  sells only; `compileAction` leaves it off). Spot legs skip the leverage, stop-loss and loss-lock rules (perp
  exposure) but count toward notional and rate limits. On mainnet, signers also cap one order on a verified pair at 10%
  of its 24 h volume (`spotOrderVolumeProblem`, with the volume they read themselves).
- `VERIFIED_SPOT_PAIRS` is Hyperliquid's own "Strict" spot list (the base-token ids its app shows by default) with a
  USDC pair, pinned per network (pair index, token indices, names, token ids). `spotTokenTrust` rates any token by its
  id: `stablecoin`, `verified` or `unverified` (apps show unverified tokens with a warning; signers refuse them).
- `setReferrer` stays hard-denied unless the policy names `referralCode`; then only a raw wire subject carrying exactly
  that code, for the master account, passes (the signer must also make sure it is signed once). `startFeeTrial`
  (`{type, addBaseRate, crossBaseRate}`) is allow-listable and master-only. Build both with `compileAccountAction`
  (`@kokoah/shared/actions`): the referral code comes from the signer's own configuration, and the fee trial intent
  names a VIP tier whose rates the signer takes from the `userFees` fee schedule it read itself.

### `errors`
`mapHlError(text)` → `{ code, title, message, retryable, category, raw, hlType?, details? }`, `mapOrderStatus(status)`,
`parseExchangeResponse(body, expectedCount?)` (handles `status:"err"`, per-order errors, single pre-validation errors
for a batch), `HL_ERROR_CATALOG`. Covers FRONTEND_SPEC §9.10 plus HL's error table.

### `guardians`
Schemas and types for the nine rule types (`protectPartialFills`, `breakeven`, `takeProfitLadder`, `trailingStop`,
`timeExit`, `ocoEntries`, `conditional`, `liquidationGuard`, `dailyLossLock`), `parseGuardianRule`, and the pure
`evaluateRule(rule, marketState, positionState, now)` → `{ fire, intents, alerts, nextState, status, reason }`.
`isLossLockActive(rule, now)` feeds `PolicyContext.lossLockActive`.

```ts
let rule = parseGuardianRule({ type: "trailingStop", id: crypto.randomUUID(), createdAt: now, coin: "BTC",
                               trail: { kind: "pct", value: 1.5 } });
const out = evaluateRule(rule, { BTC: { markPrice, szDecimals: 5 } }, { account, positions, orders }, now);
// send out.intents through compile + policy + sign; after they are accepted, persist:
rule = { ...rule, state: out.nextState, status: out.status };
```

Evaluation is deterministic: cloids are derived from `rule.id` + a sequence number in the state, so re-evaluating the
same inputs yields the same cloids. Use unique rule ids (UUIDs) per user, and query `orderStatus` by cloid before
re-sending after a crash.

Safety properties (tested): breakeven moves the stop once; the trailing stop only ratchets in the favorable direction
and never loosens an existing exchange stop (pass open orders with their `triggerPrice`; a stop of unknown price is
not modified); the take-profit ladder never closes more than 100% of the size it was armed on; breakeven, ladder and
trailing rules pin the position side and complete instead of acting on a flipped position; no rule emits a zero-size
order.

### `link`
Device linking ("Link phone"): `deviceLinkCode({ secret, pairingId, userAddress, agentAddress, agentName,
validUntil })` is the 6-digit matching code both the computer and the phone show before the main wallet approves the
phone's own agent key. It is HMAC-SHA256 keyed with the link secret (16 random bytes from the QR code's URL fragment,
never sent to a server) over those fields, so a relay that swaps the agent address produces a different code. Also
`generateLinkSecret`, `formatLinkCode` ("482 913"), `deviceLinkCodeMessage`, `hmacSha256`, `sha256Bytes` and base64url
helpers. Dependency-free (its own SHA-256, checked against node:crypto), so importing it adds no hashing library.
Subpath export only (`@kokoah/shared/link`), not re-exported from the root.

### `subaccounts`
Sub-accounts as "strategy accounts". The master's agent key trades for a sub-account by setting `vaultAddress`, and HL
accepts the same field for a vault the master leads, so signers allow it only for an address that HL's own
`{"type":"subAccounts","user":master}` lists for that master. `parseSubAccounts(raw, master)` reads that answer and fails
closed (malformed entries, another master, the master itself and repeats are dropped). `SubAccountOwnership` wraps it
in a cache for signers (`find`, `isOwned`, `list`, `invalidate`): 30 s TTL, a re-read on a miss once the list is 5 s
old, shared in-flight reads, and `SubAccountLookupError` when HL can't be read (deny, never allow). Also `accountOf`
and `isAccountAddress`. Subpath export only (`@kokoah/shared/subaccounts`).

---

## Golden vectors (signing matches the official Python SDK)

`test/golden/vectors.json` holds 29 vectors produced by `hyperliquid-python-sdk` 0.24.0 with fake keys and fixed
nonces: 18 L1 actions (orders with builder, normalTpsl, HIP-3 IOC, vault, expiresAfter, vault + expiresAfter,
stop-limit positionTpsl, cancel with a >2³² oid, cancelByCloid, updateLeverage, negative updateIsolatedMargin,
scheduleCancel set/clear, modify by oid / by cloid, batchModify, noop) and 6 user-signed actions (approveAgent
mainnet/testnet, approveBuilderFee mainnet/testnet and with `signatureChainId` 0xa4b1, withdraw3).
`test/golden.test.ts` checks the L1 hash, `r, s, v` of every vector, byte-identical `compileAction` output for the 16
vectors that correspond to an intent, and user-signed signatures through both our typed data and the SDK wrapper.

Regenerate (venv outside the repo):

```sh
python3 -m venv /tmp/kokoah-golden-venv
/tmp/kokoah-golden-venv/bin/pip install hyperliquid-python-sdk==0.24.0
/tmp/kokoah-golden-venv/bin/python scripts/golden/generate.py > test/golden/vectors.json
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm test golden
```

See `scripts/golden/README.md`.

## Fixtures

`test/fixtures/` holds real `/info` responses captured on 2026-09-21 (read-only): mainnet `allPerpMetas`, `perpDexs`,
`spotMeta`, `perpConciseAnnotations`; testnet `meta`, `perpDexs`.

## Testnet spikes

`spikes/` has scripts a human runs on **testnet** with their own funded key (`TESTNET_MAIN_PRIVATE_KEY`) to settle open
questions (agent expiry, agent permissions, builder-approval limit, order with builder). They refuse to run otherwise.
Only the read-only WebSocket spike has been run; see `spikes/README.md` and `spikes/FINDINGS.md`.

---

## Contract for other repos

These names and shapes are the stable 0.1 API. All are exported from `@kokoah/shared` and from the listed subpath.

### `ActionIntent` (`@kokoah/shared/intents`)

```ts
type IntentOrigin = "manual" | "guardian" | "ai_ticket";
type OrderType = "market" | "limit" | "stopMarket" | "stopLimit" | "takeProfitMarket" | "takeProfitLimit";

interface TpslLeg { triggerPrice: string; orderType: "market" | "limit"; limitPrice?: string; cloid?: `0x${string}` }

type OrderIntent = {
  kind: "order"; coin: string; side: "buy" | "sell"; orderType: OrderType;
  size: string;                       // coin units, decimal string
  price?: string;                     // limit, stopLimit, takeProfitLimit
  triggerPrice?: string;              // stop*/takeProfit* (mark price)
  tif?: "Gtc" | "Ioc" | "Alo";        // limit only (default Gtc)
  reduceOnly: boolean;                // default false
  slippageBps?: number;               // market only, 1–1000 (default 100)
  takeProfit?: TpslLeg; stopLoss?: TpslLeg;   // entry orders only → grouping normalTpsl
  positionTpsl: boolean;              // reduce-only triggers → grouping positionTpsl (default false)
  cloid?: `0x${string}`; origin: IntentOrigin; vaultAddress?: `0x${string}`;
};
type CancelIntent = { kind: "cancel"; cancels: Array<{ coin: string; oid: number } | { coin: string; cloid: `0x${string}` }>; origin; vaultAddress? };
type ModifyIntent = { kind: "modify"; target: { oid: number } | { cloid: `0x${string}` };
  order: { coin; side; orderType: Exclude<OrderType, "market">; size; price?; triggerPrice?; tif?; reduceOnly: boolean; cloid? }; origin; vaultAddress? };
type UpdateLeverageIntent = { kind: "updateLeverage"; coin: string; leverage: number; marginMode: "cross" | "isolated"; origin; vaultAddress? };
type UpdateIsolatedMarginIntent = { kind: "updateIsolatedMargin"; coin: string; amountUsd: string /* signed */; origin; vaultAddress? };
type ScheduleCancelIntent = { kind: "scheduleCancel"; time?: number; origin; vaultAddress? };
type NoopIntent = { kind: "noop"; origin; vaultAddress? };
type ActionIntent = OrderIntent | CancelIntent | ModifyIntent | UpdateLeverageIntent | UpdateIsolatedMarginIntent | ScheduleCancelIntent | NoopIntent;
type ActionIntentInput;  // same, before normalization (numbers allowed for decimals, defaults optional)

const ActionIntentSchema;                                   // valibot
function parseActionIntent(input: unknown): ActionIntent;   // throws IntentValidationError
function safeParseActionIntent(input: unknown): { success: true; intent: ActionIntent } | { success: false; issues: Array<{ message: string; path?: string }> };
```

### `compileAction` (`@kokoah/shared/actions`)

```ts
function compileAction(intent: ActionIntent | ActionIntentInput, options: CompileOptions): CompiledAction;
interface CompileOptions {
  registry: MarketRegistry;
  builder?: { address: `0x${string}`; feeTenthsBps: number } | null;
  getMidPrice?: (coin: string) => number | string | undefined;   // market orders
  newCloid?: (origin: IntentOrigin) => `0x${string}`;            // default generateCloid(origin)
  now?: number;                                                   // scheduleCancel ≥ 5 s check
}
interface CompiledAction {
  action: HlAction;               // canonical key order; sign exactly this
  vaultAddress?: `0x${string}`;
  cloids: `0x${string}`[];        // parent first
  marketOrder?: { midPrice: string; limitPrice: string; slippageBps: number };
  intent: ActionIntent;           // validated, normalized
}
class CompileError extends Error { code: "INVALID_INTENT" | "UNKNOWN_MARKET" | "DELISTED_MARKET" | "SIZE_PRECISION" | "PRICE_PRECISION"
  | "MISSING_MID_PRICE" | "LEVERAGE_ABOVE_MAX" | "CROSS_NOT_ALLOWED" | "INVALID_BUILDER" | "MARGIN_PRECISION" | "SCHEDULE_TOO_SOON" | "UNSUPPORTED" }
function generateCloid(originTag?: IntentOrigin | `0x${string}`): `0x${string}`;
```

### Signing helpers (`@kokoah/shared/signing`)

```ts
type AbstractWallet;  // re-exported from @nktkas/hyperliquid/signing: viem LocalAccount / JSON-RPC account, ethers signers
type Signature = { r: `0x${string}`; s: `0x${string}`; v: 27 | 28 };

function signL1Action(p: { wallet: AbstractWallet; action; nonce: number; network: { isTestnet: boolean }; vaultAddress?; expiresAfter? }): Promise<Signature>;
function hashL1Action(p: { action; nonce; vaultAddress?; expiresAfter? }): `0x${string}`;          // connectionId
function l1SigningDigest(p: { action; nonce; network; vaultAddress?; expiresAfter? }): `0x${string}`; // EIP-712 digest
function recoverL1Signer(p: { action; nonce; network; vaultAddress?; expiresAfter?; signature: Signature }): Promise<`0x${string}`>;

interface PreparedUserSignedAction { action: Record<string, unknown>; typedData: UserSignedTypedData; nonce: number }
function buildApproveAgent(p: { agentAddress; agentName: string; validUntil: number; nonce: number; network; signatureChainId?; now? }): PreparedUserSignedAction;
function buildRevokeAgent(p: { agentName; nonce; network; signatureChainId? }): PreparedUserSignedAction;
function buildApproveBuilderFee(p: { builder; maxFeeTenthsBps: number /* 0–100 */; nonce; network; signatureChainId? }): PreparedUserSignedAction;
function buildWithdraw(p: { destination; amount: string | number; nonce; network; signatureChainId? }): PreparedUserSignedAction;
function signUserSignedAction(p: { wallet; action; types }): Promise<Signature>;

interface NonceManager { next(key?: string): number; observe?(nonce: number, key?: string): void }
class MonotonicNonceManager implements NonceManager { constructor(o?: { now?: () => number; clockOffsetMs?: number }); peek(key?); setClockOffset(ms) }

function buildExchangeRequest(p: { network; action; nonce; signature; vaultAddress?; expiresAfter? }): ExchangeRequestBody; // mainnet guard
function prepareL1Request(p: { wallet; network: NetworkConfig; compiled: { action; vaultAddress? }; nonce; expiresAfter? }): Promise<ExchangeRequestBody>;
```

### `Policy` and `evaluatePolicy` (`@kokoah/shared/policy`)

```ts
type Policy = {
  version: 1;
  allowedActionTypes: Array<"order" | "cancel" | "cancelByCloid" | "modify" | "batchModify" | "updateLeverage"
    | "updateIsolatedMargin" | "topUpIsolatedOnlyMargin" | "scheduleCancel" | "noop" | "startFeeTrial">;
  allowedCoins: "*" | string[];
  maxOrderNotionalUsd: number;
  maxDailyNotionalUsd: number;
  maxLeverage: number;
  requireStopLossForNewEntries: boolean;
  maxOrdersPerMinute: number;
  maxStopLossDistancePct?: number;                   // attached stop within X% of entry (optional)
  priceBandPct: number;                              // orders that execute now vs mark (resting limits: 50%)
  allowedVaultAddresses: `0x${string}`[];            // [] = master account only
  requiredBuilder: { b: `0x${string}`; f: number } | null;
  maxExpiresAfterWindowMs: number | null;            // non-null ⇒ expiresAfter required and ≤ now + window
  allowedOrigins?: IntentOrigin[];
  exemptReduceOnlyFromNotionalCaps: boolean;         // default true
  allowedSpotCoins?: string[];                       // spot pairs (IOC only); omitted = no spot
  spotTrading?: boolean;                             // with allowedSpotCoins: also GTC/ALO limits (no triggers)
  referralCode?: string;                             // the one code setReferrer may carry; omitted = denied
};

function evaluatePolicy(subject: ActionIntent | { kind: "compiled"; compiled: CompiledAction; expiresAfter? }
                                 | { kind: "wire"; action: { type: string }; vaultAddress?; expiresAfter?; origin? },
                        context: PolicyContext): { allowed: boolean; violations: Array<{ code: PolicyViolationCode; message: string }>; actionType: string };

interface PolicyContext {
  policy: Policy; now: number; markPrices: Record<string, number>; dailyNotionalUsedUsd: number; ordersInLastMinute: number;
  registry?: MarketRegistry;          // required for wire/compiled subjects
  policyExpiresAt?: number; expiresAfter?: number; hasStopLoss?: (coin: string) => boolean;
  leverageByCoin?: Record<string, number>; lossLockActive?: boolean;
  midPrices?: Record<string, number>; // evaluator's own book mids: refines which limits are marketable
}

function preparePolicySignature(policy: PolicyInput | Policy, auth: PolicyAuthorization): { authorization: PolicyAuthorization /* typedDataVersion: 2 unless given */; typedData };
function buildPolicyTypedData(policy: PolicyInput | Policy, auth: { user; agent?; network: "Mainnet" | "Testnet"; chainId; issuedAt; expiresAt; nonce; typedDataVersion?: 1 | 2 /* omitted: 1 */ });
function policyTypedDataFields(version?: 1 | 2 /* default 2 */): Array<{ name: string; type: string; shows: PolicyFieldName[] }>;
function verifyPolicySignature(signed: { policy; authorization; signature: `0x${string}` }, options?: { now?: number /* default Date.now() */; ignoreExpiry?: boolean; clockSkewMs?: number /* issuedAt tolerance, default 0; services: 300_000 */ }): Promise<boolean>;
```

Violation codes: `WITHDRAWAL_DENIED`, `TRANSFER_DENIED`, `VAULT_ACTION_DENIED`, `SUBACCOUNT_ACTION_DENIED`,
`REFERRER_ACTION_DENIED`, `RATE_LIMIT_PURCHASE_DENIED`, `APPROVAL_DENIED`, `ACCOUNT_CONFIG_DENIED`, `TWAP_DENIED`,
`STAKING_OR_REWARDS_DENIED`, `DEPLOYER_ACTION_DENIED`, `ACTION_TYPE_NOT_ALLOWED`, `POLICY_EXPIRED`,
`ORIGIN_NOT_ALLOWED`, `VAULT_NOT_ALLOWED`, `EXPIRES_AFTER_REQUIRED`, `EXPIRES_AFTER_IN_PAST`, `EXPIRES_AFTER_TOO_FAR`,
`UNKNOWN_MARKET`, `COIN_NOT_ALLOWED`, `MARK_PRICE_UNAVAILABLE`, `ORDER_NOTIONAL_EXCEEDED`, `DAILY_NOTIONAL_EXCEEDED`,
`PRICE_OUTSIDE_BAND`, `LEVERAGE_EXCEEDED`, `STOP_LOSS_REQUIRED`, `DAILY_LOSS_LOCKED`, `ORDER_RATE_EXCEEDED`,
`BUILDER_REQUIRED`, `BUILDER_MISMATCH`, `INVALID_SUBJECT`.

### `GuardianRule` and `evaluateRule` (`@kokoah/shared/guardians`)

```ts
type GuardianRule = ProtectPartialFillsRule | BreakevenRule | TakeProfitLadderRule | TrailingStopRule | TimeExitRule
                  | OcoEntriesRule | ConditionalRule | LiquidationGuardRule | DailyLossLockRule;   // discriminator: type
// Common fields: id, status ("armed" | "triggered" | "completed" | "paused" | "failed" | "expired"), createdBy
// ("manual" | "ai_assisted"), createdAt, expiresAt?, vaultAddress?, slippageBps?, state? (engine-persisted).
function parseGuardianRule(input: unknown): GuardianRule;   // throws GuardianRuleValidationError

function evaluateRule(rule: GuardianRule, marketState: MarketState, positionState: PositionState, now: number): {
  fire: boolean; intents: ActionIntent[]; alerts: GuardianAlert[]; nextState: /* rule's state type */; status: GuardianStatus; reason: string;
};
type MarketState = Record<string, { markPrice: number; midPrice?: number; oraclePrice?: number; fundingRateHourly?: number;
  szDecimals: number; priceKind?: "perp" | "spot"; lastClosedCandles?: Partial<Record<CandleInterval, { closeTime: number; close: number }>> }>;
type PositionState = {
  account: { equityUsd: number; realizedPnlTodayUsd?: number; dayStartEquityUsd?: number };
  positions: Record<string, { side: "long" | "short"; size: number; entryPrice: number; liquidationPrice: number | null; marginMode: "cross" | "isolated" }>;
  orders: Array<{ coin; oid?; cloid?; side: "buy" | "sell"; status: "open" | "filled" | "canceled" | "rejected" | "triggered"; origSize: number;
                  filledSize: number; triggerPrice?: number /* required for stops a rule should manage */ }>;
};
```

### `assessOrderRisk` (`@kokoah/shared/risk`)

```ts
function assessOrderRisk(input: OrderRiskInput): OrderRiskAssessment;
// OrderRiskInput: market { coin, maxLeverage, marginTiers?, onlyIsolated? }, side, size, orderType, expectedFillPrice?,
//   limitPrice?, triggerPrice?, markPrice, oraclePrice?, leverage, marginMode, reduceOnly?, postOnly?, stopLoss?,
//   takeProfit?, account { equityUsd, availableMarginUsd?, otherPositionsMaintenanceMarginUsd?, otherPositionsNotionalUsd? },
//   existingPosition?, fees { takerRate, makerRate, builderFeeTenthsBps? }, fundingRateHourly?, book?,
//   weekendOrOffHoursPricing?, atOpenInterestCap?, thresholds?
// OrderRiskAssessment: expectedFillPrice, orderNotionalUsd, marginRequiredUsd, resultingAction, positionAfter,
//   effectiveAccountLeverage, liquidationPrice, liquidationDistanceFromEntryPct, liquidationDistanceFromMarkPct,
//   stopLoss (StopLossEstimate & { pctOfEquity }) | null, noStopLoss, fees { entry, exit, roundTripUsd, roundTripBps },
//   funding, marketImpact, warnings: RiskWarning[] ({ code, severity, blocking, message, data? }), blocking
```

---

## Known limitations and open questions

- **Market-type trigger limit price.** For `isMarket: true` triggers the compiler sends `p = trigger ± 10%` (HL's
  documented market TP/SL tolerance), or one tick beyond the trigger when the tick is coarser than 10% of the price. HL's docs don't state what `p` must be for market triggers; verify on testnet.
- **`modify` carries no builder field** in HL's schema; whether a modified order keeps the original order's builder fee
  is undocumented. Policy only enforces the builder on `order` actions.
- **Modify by cloid, reusing the cloid** on the replacement order: untested against HL (spike 02 checks it). Guardians
  therefore assign a fresh derived cloid on every modify.
- **Position TP/SL "whole position" size.** HL's UI can create position TP/SL that track the whole position; the API
  mechanism for that (e.g. size 0) is undocumented, so Kokoah always sends a fixed size.
- **Liquidation price for cross** holds other positions' maintenance margin constant and ignores funding; for unified
  and portfolio-margin accounts, pass the collateral that actually backs the position.
- **Fees:** pass the user's effective rates from `userFees` (after referral/staking discounts) or the HIP-3 market's own
  (growth-mode) rates; the library does not derive them.
- Spot orders compile (8-decimal price rule, builder up to 1000) but the product and tests focus on perps.
- `verifyPolicySignature` supports EOA signatures only (no ERC-1271 smart-contract wallets). Policies signed in typed-data
  format 1 bind some fields (sub-accounts, origins, the daily loss limit, stop-loss exceptions, the expiresAfter window,
  the reduce-only exemption, spot, the referral code) only by `policyHash`; a UI describing such a stored policy must
  verify its signature first and show those fields itself. Format 2 shows every field.
- Market orders on markets with coarse ticks: when one tick is wider than the slippage tolerance, the IOC price is one
  tick beyond the tolerance (to stay marketable).
- `updateIsolatedMargin` amounts are capped only for automation keys (policies whose `allowedOrigins` leave out
  `manual`): they may add at most `maxOrderNotionalUsd` per action and never remove margin. Keys with manual trading
  are not capped (HL itself keeps initial margin on removal).
- Named agents are limited to 3 per master account without sub-accounts; the library does not manage slots.
