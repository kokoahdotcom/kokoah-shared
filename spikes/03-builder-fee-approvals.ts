/**
 * Spike 03 (TESTNET ONLY): builder-fee approvals.
 * 1. Approve SPIKE_BUILDER_ADDRESS (if set) at 0.1% and read back `maxBuilderFee` / `approvedBuilders`.
 * 2. Approve fresh random builder addresses (f = 1, i.e. 0.001%) until HL refuses, to capture the exact error at the
 *    10-approval limit (the limit counts existing approvals too).
 * 3. Revoke every random approval made here (maxFeeRate "0%") and read back.
 *
 * Set SPIKE_SKIP_LIMIT=1 to skip steps 2–3.
 */
import { buildApproveBuilderFee } from "@kokoah/shared";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { setupTestnetSpike, show, sleep } from "./_common.ts";

const ctx = await setupTestnetSpike();
const user = ctx.main.address;
const approve = (builder: `0x${string}`, f: number) => ctx.postUserSigned(buildApproveBuilderFee({ builder, maxFeeTenthsBps: f, nonce: ctx.nonces.next(user), network: ctx.network }));

show("approvedBuilders (before)", await ctx.info.approvedBuilders({ user }));

const builder = process.env.SPIKE_BUILDER_ADDRESS as `0x${string}` | undefined;
if (builder) {
  show(`approve ${builder} at 0.1%`, await approve(builder, 100));
  await sleep(1500);
  show("maxBuilderFee (tenths of a bp)", await ctx.info.maxBuilderFee({ user, builder }));
}

if (process.env.SPIKE_SKIP_LIMIT !== "1") {
  const made: `0x${string}`[] = [];
  for (let i = 0; i < 11; i++) {
    const b = privateKeyToAccount(generatePrivateKey()).address;
    const res = await approve(b, 1);
    console.log(`approval #${i + 1} for ${b}: ${JSON.stringify(res.raw)}`);
    if (!res.outcome.ok) {
      show("FIRST REFUSAL (expected at the 10-approval limit)", res);
      break;
    }
    made.push(b);
    await sleep(300);
  }
  show("approvedBuilders (at limit)", await ctx.info.approvedBuilders({ user }));
  for (const b of made) {
    const res = await approve(b, 0);
    console.log(`revoke ${b}: ${JSON.stringify(res.raw)}`);
    await sleep(300);
  }
  show("approvedBuilders (after revoking spike approvals)", await ctx.info.approvedBuilders({ user }));
}
