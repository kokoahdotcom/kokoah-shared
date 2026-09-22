/**
 * Spike 02 (TESTNET ONLY): which L1 actions will HL accept when signed by an AGENT key?
 * - scheduleCancel (set, then clear)
 * - batchModify (two tiny post-only orders far from mark, modified, then cancelled)
 * - modify by cloid keeping the same cloid on the replacement order
 * - setReferrer — ONLY if SPIKE_REFERRAL_CODE is set, because a referrer can be set only once per account.
 *
 * The agent is approved with a short expiry and revoked at the end.
 */
import { BatchModifyRequest } from "@nktkas/hyperliquid/api/exchange";
import { canonicalize } from "@nktkas/hyperliquid/signing";
import {
  buildApproveAgent,
  buildRevokeAgent,
  compileAction,
  expiresAfterFromNow,
  formatSize,
  generateCloid,
  prepareL1Request,
  roundPriceToTick,
} from "@kokoah/shared";
import * as v from "valibot";
import { setupTestnetSpike, show, sleep, spikeAgentName } from "./_common.ts";

const ctx = await setupTestnetSpike();
const agent = ctx.newAgent();
const name = spikeAgentName("kspike");
show("approve agent", await ctx.postUserSigned(buildApproveAgent({ agentAddress: agent.address, agentName: name, validUntil: Date.now() + 86_400_000, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network })));
await sleep(1500);

const registry = await ctx.registry();
const coin = registry.has("BTC") ? "BTC" : (registry.list()[0]?.coin as string);
const market = registry.require(coin);
const mids = await ctx.info.allMids();
const mid = Number(mids[coin]);
const px1 = roundPriceToTick(mid * 0.5, market.szDecimals, "perp", "down");
const px2 = roundPriceToTick(mid * 0.45, market.szDecimals, "perp", "down");
const size = formatSize(12 / Number(px2), market.szDecimals, "up"); // ≥ $10 notional
console.log(`Using ${coin} mid ${mid}: resting post-only buys at ${px1} and ${px2}, size ${size}`);

async function sendAgent(intentOrAction: Parameters<typeof compileAction>[0] | { raw: Record<string, unknown> }, label: string, expected = 1) {
  const compiled = "raw" in intentOrAction ? { action: intentOrAction.raw } : compileAction(intentOrAction, { registry });
  const body = await prepareL1Request({ wallet: agent, network: ctx.network, compiled, nonce: ctx.nonces.next(agent.address), expiresAfter: expiresAfterFromNow(Date.now(), 30_000) });
  const res = await ctx.post(body, expected);
  show(label, res);
  return res;
}

// scheduleCancel set + clear
await sendAgent({ kind: "scheduleCancel", time: Date.now() + 60_000, origin: "manual" }, "scheduleCancel (set) signed by agent");
await sendAgent({ kind: "scheduleCancel", origin: "manual" }, "scheduleCancel (clear) signed by agent");

// Two resting post-only orders.
const c1 = generateCloid("manual");
const c2 = generateCloid("manual");
await sendAgent({ kind: "order", coin, side: "buy", orderType: "limit", size, price: px1, tif: "Alo", cloid: c1, origin: "manual" }, "order 1 (agent)");
await sendAgent({ kind: "order", coin, side: "buy", orderType: "limit", size, price: px2, tif: "Alo", cloid: c2, origin: "manual" }, "order 2 (agent)");

// batchModify both (move each 1 tick lower) — built with the SDK schema for canonical key order.
const wire = (price: string, cloid: string) => ({ a: market.assetId, b: true, p: price, s: size, r: false, t: { limit: { tif: "Alo" } }, c: cloid });
const lower = (p: string) => roundPriceToTick(Number(p) * 0.99, market.szDecimals, "perp", "down");
const batch = canonicalize(BatchModifyRequest.entries.action, v.parse(BatchModifyRequest.entries.action, { type: "batchModify", modifies: [{ oid: c1, order: wire(lower(px1), c1) }, { oid: c2, order: wire(lower(px2), c2) }] }));
await sendAgent({ raw: batch }, "batchModify by cloid, keeping cloids (agent)", 2);

// Single modify by cloid keeping the same cloid.
await sendAgent({ kind: "modify", target: { cloid: c1 }, order: { coin, side: "buy", orderType: "limit", size, price: px1, tif: "Alo", cloid: c1 }, origin: "manual" }, "modify by cloid keeping the cloid (agent)");

show("orderStatus c1", await ctx.info.orderStatus({ user: ctx.main.address, oid: c1 }));
await sendAgent({ kind: "cancel", cancels: [{ coin, cloid: c1 }, { coin, cloid: c2 }], origin: "manual" }, "cancelByCloid both (agent)", 2);

// setReferrer — irreversible, opt-in only.
const code = process.env.SPIKE_REFERRAL_CODE;
if (code) {
  // setReferrer is not an intent (policy denies it); build the wire action directly.
  await sendAgent({ raw: { type: "setReferrer", code } }, `setReferrer(${code}) signed by agent`);
} else {
  console.log("\nSkipping setReferrer: set SPIKE_REFERRAL_CODE to test it (a referrer can only be set once per account).");
}

show("revoke agent", await ctx.postUserSigned(buildRevokeAgent({ agentName: name, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network })));
