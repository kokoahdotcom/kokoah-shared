/**
 * Spike 01 (TESTNET ONLY): approve a NAMED agent with `valid_until`, read it back via `extraAgents`, then revoke it
 * (same name + zero address, as HL's app does) and read back again.
 *
 * Questions answered:
 * - Does `extraAgents` report our validUntil exactly? Does the stored name drop the " valid_until …" suffix?
 * - Does approving the same name with the zero address remove the agent?
 */
import { buildApproveAgent, buildRevokeAgent } from "@kokoah/shared";
import { setupTestnetSpike, show, sleep, spikeAgentName } from "./_common.ts";

const ctx = await setupTestnetSpike();
const agent = ctx.newAgent();
const name = spikeAgentName("kspike");
const validUntil = Date.now() + 2 * 24 * 60 * 60 * 1000; // 2 days

const approve = buildApproveAgent({ agentAddress: agent.address, agentName: name, validUntil, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network });
show("approveAgent action", approve.action);
show("approveAgent result", await ctx.postUserSigned(approve));

await sleep(1500);
const agents = await ctx.info.extraAgents({ user: ctx.main.address });
const mine = agents.find((a) => a.address.toLowerCase() === agent.address.toLowerCase());
show("extraAgents entry for our agent", mine ?? "NOT FOUND");
if (mine) {
  console.log(`validUntil requested ${validUntil}, reported ${mine.validUntil} (${mine.validUntil === validUntil ? "exact" : "DIFFERENT"})`);
  console.log(`stored name: ${JSON.stringify(mine.name)} (suffix stripped: ${!mine.name.includes("valid_until")})`);
}

const revoke = buildRevokeAgent({ agentName: name, nonce: ctx.nonces.next(ctx.main.address), network: ctx.network });
show("revoke (zero address) result", await ctx.postUserSigned(revoke));
await sleep(1500);
const after = await ctx.info.extraAgents({ user: ctx.main.address });
show("extraAgents after revoke (our name)", after.filter((a) => a.name === name));
