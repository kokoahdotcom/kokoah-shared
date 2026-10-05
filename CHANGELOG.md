# Changelog

All notable changes to `@kokoah/shared` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(pre-1.0: minor versions may break).

## [Unreleased]

### Added
- `policy`: policy signatures in typed-data format 2 (EIP-712 domain "Kokoah Policy", version "2",
  `POLICY_EIP712_TYPES_V2`): besides format 1's fields, the wallet shows `allowedOrigins`, `allowedSubAccounts`,
  `reduceOnlyExemptFromCaps`, `maxDailyLossUsd`, `maxStopLossDistancePct`, `botsWithoutStopLoss`,
  `maxActionLifetimeMs`, `allowedSpotPairs`, `spotTrading` and `referralCode`, so no policy field is bound only through
  `policyHash` any more. `PolicyAuthorization.typedDataVersion` names the format (omitted: 1, the original);
  `buildPolicyTypedData`, `recoverPolicySigner` and `verifyPolicySignature` use the format it names, so format 1
  signatures keep verifying. `preparePolicySignature` starts a new signature in `POLICY_TYPED_DATA_VERSION` (2).
  `policyTypedDataFields(version)` lists a format's fields with the policy fields each shows. The policy schema, its
  `version` and its hash are unchanged; format 1's types and golden digest are unchanged.
- `policy`: `PolicyContext.requireLeverage` (opt-in). Every perp entry leg (not reduce-only) must then have its coin in
  `leverageByCoin`; a missing one is `LEVERAGE_EXCEEDED` instead of an unchecked leg. The signer service sets it with
  the leverage it reads itself; other callers keep the old behaviour.
- `errors`: `AGENT_LIMIT` for Hyperliquid's refusal of a named agent past the account's allowance ("Too many extra
  agents for cumulative volume traded. Current limit is 3"), with `details.agentLimit`.
- `ops` (new entry point): operator alerts shared by the backend and the signer service. `scrubOpsText` (credentials,
  tokens, API keys, webhook URLs, PEM, keys and signatures, wallet, e-mail and IP addresses, control characters),
  `stackFrames`, `opsFingerprint` / `normalizeForFingerprint` (one bug, one alert), `cleanOpsEvent`, `OpsAggregator`
  (per-process grouping with an overflow cap), `OPS_COOLDOWN_MS` by severity, `opsWebhookKind` (Discord or
  Slack-compatible; https only), `parseDiscordMention`, `discordPayloads` / `slackPayloads` (within Discord's limits;
  untrusted text in code blocks, no mentions except the configured one on critical alerts), `postOpsWebhook` (429
  waits, rejected webhooks, refused payloads) and `sendOpsBatch`.
- `policy`: `spotTrading` (optional; with `allowedSpotCoins` the listed pairs may be traded with market orders and IOC,
  GTC and post-only limits within the price bands, still one order with no modify, trigger, reduce-only or grouping;
  omitted: Convert's IOC-only rule, so existing policies and hashes are unchanged). `VERIFIED_SPOT_PAIRS` (Hyperliquid's
  "Strict" spot tokens with a USDC pair, pinned per network: 50 on mainnet, 6 on testnet), `verifiedSpotPairs`
  (stablecoin and verified pairs a live `spotMeta` confirms exactly, failing closed), `verifiedSpotPairCoins`,
  `spotPairMatches`, `spotTokenTrust` (`stablecoin` / `verified` / `unverified`, by token id), `USDC_TOKEN`, and the
  mainnet per-order volume cap for signers (`SPOT_ORDER_MAX_SHARE_OF_DAY_VOLUME` 10%, `spotOrderCapUsd`,
  `spotOrderVolumeProblem`).
- `actions`: `compileAccountAction` with `AccountIntentSchema` (`setReferrer`, and `startFeeTrial` naming a VIP tier
  by number; manual origin only; the referral code comes from the signer's configuration and the tier's rates from the
  fee schedule the signer read itself), `feeTrialRate`, `safeParseAccountIntent`, `isAccountIntentKind`. `setReferrer`
  and `startFeeTrial` (`{type, addBaseRate, crossBaseRate}`, the shape Hyperliquid's app sends; no SDK has it yet) are
  checked against new golden vectors signed with the Python SDK's L1 path.
- `policy`: `allowedSpotCoins` (spot pairs a key may trade, single IOC orders only; default none) and `referralCode`
  (the one code `setReferrer` may carry), both optional, so existing policies and their hashes are unchanged.
  `startFeeTrial` is allow-listable (master account only, exactly two decimal rate fields). New violation codes
  `SPOT_NOT_ALLOWED` and `FEE_TRIAL_UNAVAILABLE` (for signers that read the account's trial state).
- `policy`: `STABLECOIN_PAIRS` (stablecoin/USDC pairs pinned per network from `spotMeta`: mainnet USDT0 and USDE,
  testnet TZERO and USDZZ), `stablecoinPairCoins` and
  `verifiedStablecoinPairs` (checks a live `spotMeta` against the pins, failing closed).

### Changed
- `evaluatePolicy`: spot orders are denied unless listed in `allowedSpotCoins` (before, a spot coin passed with
  `allowedCoins: "*"` when the registry had spot markets). Spot sells need the exact builder; spot buys must carry
  none. `setReferrer` with exactly the policy's `referralCode` is the one exception to the hard deny.
- `compileAction`: spot buys carry no builder field (Hyperliquid charges builder fees on spot sells only); checked
  against new Python SDK golden vectors.
- `signing`: `buildSendAsset` (readable `HyperliquidTransaction:SendAsset` for the main wallet; `fromSubAccount` is
  the main account unless given) and `buildAccountMode` (`userSetAbstraction`, Standard or Unified; `ACCOUNT_MODES`,
  `AccountMode`), both checked against new Python SDK golden vectors.
- `link` (new subpath `@kokoah/shared/link`): `deviceLinkCode`, the 6-digit matching code for linking a phone (HMAC-SHA256
  keyed with the QR code's link secret over pairing id, account, agent address, agent name and expiry), plus
  `generateLinkSecret`, `formatLinkCode`, `deviceLinkCodeMessage`, `hmacSha256`, `sha256Bytes` and base64url helpers
  (dependency-free).

- `subaccounts` (new subpath `@kokoah/shared/subaccounts`): `parseSubAccounts` (HL `subAccounts` answer → the
  master's sub-accounts, failing closed on anything malformed or of another master), `SubAccountOwnership` (cached,
  fail-closed "is this a sub-account of that master?" check with a re-read on a miss; signers deny when HL can't be
  read), `accountOf` and `isAccountAddress`.
- `signing`: `buildSendAsset` takes an optional `fromSubAccount` (signed as a readable field), and
  `buildSubAccountTransfer` moves funds between the main account and one of its sub-accounts with one `sendAsset`
  (checked against a new Python SDK golden vector).

## [0.1.3] - 2026-09-23

### Changed
- `evaluatePolicy`: the price band now depends on whether the order executes now or rests. Market orders, IOC and
  marketable limits (a buy at or above min(mark, mid), a sell at or below max(mark, mid)) keep `priceBandPct`.
  Resting, non-marketable GTC/ALO limits may sit up to the new `RESTING_PRICE_BAND_PCT` (50%) from mark (or
  `priceBandPct` when wider), so "buy 20% below the market" is allowed while typos like 8500 for 85000 are still
  refused. Trigger orders: limit within max(`priceBandPct`, 10%) of the trigger (unchanged), a trigger that would fire
  now banded against mark at `priceBandPct` (unchanged), and **new**: an untriggered trigger must be within the
  resting band of mark. Evaluator logic only; the signed policy type and digest are unchanged (golden test).
- `PolicyContext.midPrices` (optional): the evaluator's own book mids, used to classify marketable limits.
- `assessOrderRisk`: `BELOW_MIN_NOTIONAL` now blocks reduce-only partial closes too. Hyperliquid only exempts a
  reduce-only order that closes the whole position (a funded testnet run saw a $8.55 partial close rejected).

### Added
- `policy`: `checkLimitPriceBand`, `checkTriggerPriceBand`, `triggerLimitBandProblem`, `isMarketableLimit`,
  `isTriggerCrossed`, `restingPriceBandPct`, `RESTING_PRICE_BAND_PCT`, so UIs show the same rule while the user types.
- `precision`: `minOrderSize(price, szDecimals)` and `checkMinOrderNotional(...)` with the valid size to suggest.

## [0.1.2] - 2026-09-22

### Fixed
- `marketTriggerLimitPrice` (the limit price of market-type triggers: `stopMarket`, `takeProfitMarket` and market
  TP/SL legs) now follows the same rule as `marketOrderLimitPrice`: when rounding trigger ± 10% toward the trigger
  lands on the trigger itself (the tick is coarser than 10% of the price, e.g. trigger `0.00001` with `szDecimals` 1),
  it rounds one tick away instead, so the triggered order keeps room to fill. 0.1.1 sent `p` equal to the trigger,
  which a fast market leaves unfilled. A sell at the smallest positive tick keeps it (there is no lower price). The
  result can exceed the 10% tolerance by one tick, so on these markets `evaluatePolicy`'s trigger band
  (max(`priceBandPct`, 10%)) now denies the wire leg with `PRICE_OUTSIDE_BAND` instead of letting an unfillable stop
  through. Prices with at least ten ticks of room are unchanged.

### Removed
- `actionType(action)` from `actions` (unused; read `action.type`).
- `maxLeverageAt(tiers, notional)` from `risk` (unused duplicate of `maxLeverageForNotional`).

## [0.1.1] - 2026-09-22

### Fixed
- `MarketRegistry.fromInfo` no longer fails as a whole on an unparseable coin name. Live HL testnet metadata contains
  names such as `VOLMEX:$EVIV`, `i<3fl:TEST` and `tndex:A B:C`, and 0.1.0 threw, so no registry could be built at all.
  Unparseable entries are now skipped: they keep their positional index (every other market's asset id stays
  correct), are untradeable, fail `validateCoin`, and are reported by the new `registry.skippedEntries()` and
  `DexInfo.skippedMarkets`. Structural mismatches still throw, because they would produce wrong asset ids: a
  *parseable* coin on the wrong dex, or `perpDexs` that doesn't line up with `allPerpMetas`. Pass `strict: true`
  for the 0.1.0 behaviour. Reported by kokoah-signer-service (`docs/SHARED_ISSUES.md` #1).

### Added
- `verifyPolicySignature(signed, { clockSkewMs })`: tolerance for `issuedAt` ahead of the verifier's clock. Default 0.
  It never extends `expiresAt`. (SHARED_ISSUES #2)
- `prepareL1Request` accepts `compileAction`'s result directly; the `HlAction` type needs no cast. (SHARED_ISSUES #4)
- Test fixture: a live testnet `allPerpMetas` + `perpDexs` snapshot (2026-09-22).

## [0.1.0] - 2026-09-21

### Added
- `network`: mainnet/testnet endpoints and signing flags, testnet default, `parseNetworkName`, `assertWriteAllowed`
  mainnet write guard.
- `markets`: asset ids (perp, spot, HIP-3, outcome), HIP-3 coin parsing, `MarketRegistry` from `allPerpMetas` /
  `meta` / `perpDexs` / `spotMeta` / `perpConciseAnnotations` with positional ids for delisted markets, margin tiers,
  margin modes, display names and categories, and `validateCoin`.
- `precision`: exact-decimal price/size rounding per HL tick and lot rules, validation with suggestions, $10 minimum.
- `risk`: margin tiers, initial/maintenance margin, tier-aware liquidation price, PnL/ROE, itemized fees, funding,
  max loss at stop, R-multiple, book impact, and `assessOrderRisk` with typed warnings.
- `intents`: valibot schemas for order, cancel, modify, leverage, isolated margin, schedule cancel and noop intents.
- `actions`: `compileAction` producing canonical HL wire actions via the SDK's schemas; Kokoah-tagged cloids.
- `signing`: L1 and user-signed signing wrappers, EIP-712 builders for approveAgent / approveBuilderFee / withdraw3,
  digest helpers for KMS signers, `MonotonicNonceManager`, guarded `/exchange` request assembly.
- `policy`: deny-by-default signing policy with hard-denied fund movements, limits, presets, and EIP-712 signed
  policies with verification.
- `errors`: HL error strings and order statuses mapped to stable codes and plain-English messages.
- `guardians`: nine guardian rule types with schemas and pure, deterministic `evaluateRule`.
- Security review fixes before release: fail-closed validation of wire actions in `evaluatePolicy`; modify/batchModify
  covered by the loss lock and stop-loss rule; trigger legs valued at `max(limit, trigger, mark)` and banded against
  mark when already crossed; stop-loss coverage and optional `maxStopLossDistancePct`; `allowedCoins` enforced on
  cancels; guardians never loosen an existing stop and ignore flipped positions; tier-boundary fix in
  `liquidationPrice`; chain check in `buildExchangeRequest`; bounded `MonotonicNonceManager.observe`.
- Golden signing vectors from `hyperliquid-python-sdk` 0.24.0 (24 vectors), real `/info` fixtures, testnet spikes
  and a read-only WebSocket finding.
