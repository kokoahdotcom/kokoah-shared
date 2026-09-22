/**
 * Spike 05 (TESTNET ONLY): what expiry does HL give agents approved WITHOUT `valid_until`?
 * Research estimate: ~90 days for named agents, ~14 days for the unnamed agent (research B §1.5).
 *
 * Uses the SDK's ExchangeClient directly because Kokoah's builder always sets `valid_until`.
 * The unnamed-agent check is opt-in (SPIKE_INCLUDE_UNNAMED=1) because approving a new unnamed agent de-registers the
 * account's current unnamed agent (the one HL's own web app uses).
 */
import { ExchangeClient } from "@nktkas/hyperliquid";
import { buildRevokeAgent } from "@kokoah/shared";
import { setupTestnetSpike, show, sleep, spikeAgentName } from "./_common.ts";

const ctx = await setupTestnetSpike();
const exchange = new ExchangeClient({ transport: ctx.transport, wallet: ctx.main, signatureChainId: ctx.network.defaultSignatureChainId });
const days = (ms: number | null | undefined) => (ms ? ((ms - Date.now()) / 86_400_000).toFixed(2) : "n/a");

const named = ctx.newAgent();
const name = spikeAgentName("kspike-noexp");
try {
  show("approve named agent without valid_until", await exchange.approveAgent({ agentAddress: named.address, agentName: name }));
} catch (e) {
  show("approve named agent failed", String(e));
}
await sleep(1500);
const entry = (await ctx.info.extraAgents({ user: ctx.main.address })).find((a) => a.address.toLowerCase() === named.address.toLowerCase());
show("extraAgents entry", entry ?? "NOT FOUND");
console.log(`Named agent default expiry ≈ ${days(entry?.validUntil)} days`);

if (process.env.SPIKE_INCLUDE_UNNAMED === "1") {
  const unnamed = ctx.newAgent();
  try {
    show("approve UNNAMED agent (replaces the current unnamed agent!)", await exchange.approveAgent({ agentAddress: unnamed.address, agentName: null }));
  } catch (e) {
    show("approve unnamed agent failed", String(e));
  }
  await sleep(1500);
  const web = (await ctx.info.webData2({ user: ctx.main.address })) as unknown as { agentAddress?: string; agentValidUntil?: number };
  show("webData2 agent fields", { agentAddress: web.agentAddress, agentValidUntil: web.agentValidUntil });
  console.log(`Unnamed agent default expiry ≈ ${days(web.agentValidUntil)} days`);
} else {
  console.log("Skipping the unnamed agent (set SPIKE_INCLUDE_UNNAMED=1).");
}

show("revoke named agent", await ctx.postUserSigned(buildRevokeAgent({ agentName: name, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network })));
