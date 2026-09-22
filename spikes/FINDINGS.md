# Spike findings

## WebSocket: subscribing to a non-existent coin (testnet, read-only) — run 2026-09-21 21:01 UTC

Script: `spikes/ws-invalid-coin.ts` (Node 24 global `WebSocket`, endpoint `wss://api.hyperliquid-testnet.xyz/ws`,
one `/info` `meta` request to pick and validate a real coin; no keys).

| Case | What was sent | What happened |
|---|---|---|
| A | `trades` for `BTC` (valid), then after 5 s `l2Book` for `NOTACOIN` | `BTC` ack + trades arrived, `ping` → `pong`. About **160 ms** after the invalid `l2Book` subscribe the socket fired `error` and closed with **code 1006, empty reason, `wasClean: false`**. **No message on any channel** explained it, and the valid `BTC` subscription died with the connection. |
| B | `trades` for `xyz:NOTACOIN` alone | Same: closed after about **166 ms** with code 1006, no message at all. |
| C | subscription with an unknown **type** (`notARealType`) | `{"channel":"error","data":"Error parsing JSON into valid websocket request: …"}` and the socket **stayed open** (`ping` → `pong` 4 s later). |

**Conclusion.** Confirmed on testnet: an invalid coin silently kills the whole connection (abnormal close 1006, no
error frame, no close frame), taking every other subscription on that socket with it. An unknown subscription type,
by contrast, returns an `error` message and keeps the socket.

Also noted: when the client closed connection C normally (`close(1000)`), Node still reported 1006 — the server did
not complete the close handshake. Close codes are therefore not a reliable signal of *why* a socket went away.

**Implications for the frontend and backend:**
- Always run `MarketRegistry.validateCoin(coin)` against fresh metadata before subscribing (FRONTEND_SPEC §22.1).
  Delisted HIP-3 coins are reported as `delisted`; unknown dexes as `unknown_dex`.
- A socket that drops right after a new subscription should be treated as "that subscription is invalid": resubscribe
  everything **except** the last new coin, refresh metadata, and report it.
- Do not rely on close codes or error messages to diagnose invalid coins.

## Write-path spikes (not run)

`01`–`05` are written but deliberately **not run** by the library author: they need a funded testnet key
(`TESTNET_MAIN_PRIVATE_KEY`) and perform testnet `/exchange` writes. A human should run them and append results here.
Open questions they answer:

1. `01` — Does `extraAgents` report our `validUntil` exactly, with the `valid_until` suffix stripped from the name?
   Does approving the same name with the zero address revoke a named agent?
2. `02` — Can an agent sign `scheduleCancel`, `batchModify`, `modify` (keeping the same cloid on the replacement
   order) and `setReferrer` (opt-in; one-way per account)?
3. `03` — Exact error text at the 10-builder-approval limit; does approving a builder that has no perps balance work?
4. `04` — A resting post-only order carrying `builder: {b, f}` is accepted and can be cancelled by cloid.
5. `05` — Default expiry of agents approved without `valid_until` (research estimate: ~90 days named, ~14 days unnamed).
