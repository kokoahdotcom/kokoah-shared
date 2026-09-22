/**
 * Spike 04 (TESTNET ONLY): place and cancel a tiny resting order that carries a builder field.
 * Requires SPIKE_BUILDER_ADDRESS, approved by the account for at least SPIKE_BUILDER_FEE (default 10 = 1 bp); run
 * spike 03 first. The order is post-only and 50% below mid, so it rests and never fills; it is cancelled by cloid.
 */
import {
  buildApproveAgent,
  buildRevokeAgent,
  compileAction,
  createManualTradingPolicy,
  evaluatePolicy,
  expiresAfterFromNow,
  formatSize,
  generateCloid,
  prepareL1Request,
  roundPriceToTick,
} from "@kokoah/shared";
import { refuse, setupTestnetSpike, show, sleep, spikeAgentName } from "./_common.ts";

const ctx = await setupTestnetSpike();
const builderAddress = process.env.SPIKE_BUILDER_ADDRESS as `0x${string}` | undefined;
if (!builderAddress || !/^0x[0-9a-fA-F]{40}$/.test(builderAddress)) refuse("set SPIKE_BUILDER_ADDRESS (approved via spike 03)");
const fee = Number(process.env.SPIKE_BUILDER_FEE ?? 10);
show("maxBuilderFee", await ctx.info.maxBuilderFee({ user: ctx.main.address, builder: builderAddress }));

const agent = ctx.newAgent();
const name = spikeAgentName("kspike");
show("approve agent", await ctx.postUserSigned(buildApproveAgent({ agentAddress: agent.address, agentName: name, validUntil: Date.now() + 86_400_000, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network })));
await sleep(1500);

const registry = await ctx.registry();
const coin = registry.has("BTC") ? "BTC" : (registry.list()[0]?.coin as string);
const market = registry.require(coin);
const mid = Number((await ctx.info.allMids())[coin]);
const price = roundPriceToTick(mid * 0.5, market.szDecimals, "perp", "down");
const size = formatSize(12 / Number(price), market.szDecimals, "up");
const cloid = generateCloid("manual");

const compiled = compileAction(
  { kind: "order", coin, side: "buy", orderType: "limit", size, price, tif: "Alo", cloid, origin: "manual" },
  { registry, builder: { address: builderAddress, feeTenthsBps: fee } },
);
show("compiled action", compiled.action);
const expiresAfter = expiresAfterFromNow(Date.now(), 30_000);
const decision = evaluatePolicy(
  { kind: "compiled", compiled, expiresAfter },
  { policy: createManualTradingPolicy({ builder: { b: builderAddress.toLowerCase() as `0x${string}`, f: fee } }), now: Date.now(), markPrices: { [coin]: mid }, dailyNotionalUsedUsd: 0, ordersInLastMinute: 0, registry },
);
show("policy decision", decision);
if (!decision.allowed) refuse("policy denied the spike order");

const body = await prepareL1Request({ wallet: agent, network: ctx.network, compiled, nonce: ctx.nonces.next(agent.address), expiresAfter });
show("order result", await ctx.post(body, 1));
await sleep(1000);
show("orderStatus by cloid", await ctx.info.orderStatus({ user: ctx.main.address, oid: cloid }));

const cancel = compileAction({ kind: "cancel", cancels: [{ coin, cloid }], origin: "manual" }, { registry });
show("cancel result", await ctx.post(await prepareL1Request({ wallet: agent, network: ctx.network, compiled: cancel, nonce: ctx.nonces.next(agent.address) }), 1));
show("revoke agent", await ctx.postUserSigned(buildRevokeAgent({ agentName: name, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network })));
