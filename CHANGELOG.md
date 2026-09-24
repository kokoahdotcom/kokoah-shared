# Changelog

All notable changes to `@kokoah/shared` are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(pre-1.0: minor versions may break).

## [Unreleased]

### Added
- `signing`: `buildSendAsset` (readable `HyperliquidTransaction:SendAsset` for the main wallet; `fromSubAccount` is
  always the main account) and `buildAccountMode` (`userSetAbstraction`, Standard or Unified; `ACCOUNT_MODES`,
  `AccountMode`), both checked against new Python SDK golden vectors.

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
