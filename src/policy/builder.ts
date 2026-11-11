/**
 * A signed policy's builder against Kokoah's current one. A policy caps the fee of every order at its `requiredBuilder.f`
 * (evaluate.ts), and Kokoah's signers attach the current fee (the standard one, or a promotion's below it). So when the
 * standard fee rises, a policy signed for the lower one refuses every order: it is outdated and must be signed again,
 * like an expired one. A policy signed for another builder address is outdated the same way. A policy with no builder
 * requirement is never outdated by the fee (the signers attach the current fee anyway).
 */
import { parsePolicy, type Policy } from "./schema.js";

/**
 * Kokoah's builder: its address and its STANDARD fee in tenths of a basis point (`BuilderFeeSchedule.feeTenthsBps`),
 * never a promotion's (`builderFeeAt`): a policy signed during a promotion must still allow the standard fee after it.
 * The same shape as the compiler's `BuilderConfig`, with the address as configuration gives it (any case).
 */
export interface CurrentBuilder {
  address: string;
  feeTenthsBps: number;
}

function checkFee(builder: CurrentBuilder): void {
  if (!Number.isInteger(builder.feeTenthsBps) || builder.feeTenthsBps < 0) {
    throw new RangeError("The builder's standard fee must be a whole number of tenths of a basis point");
  }
}

/**
 * Whether `policy` was signed for a builder fee below the current standard fee, or for another builder address: every
 * order under it would be refused (BUILDER_MISMATCH), so it must be signed again with {@link withCurrentBuilder}.
 */
export function policyBuilderOutdated(policy: Pick<Policy, "requiredBuilder">, builder: CurrentBuilder): boolean {
  checkFee(builder);
  const required = policy.requiredBuilder;
  if (!required) return false;
  return required.b.toLowerCase() !== builder.address.toLowerCase() || required.f < builder.feeTenthsBps;
}

/**
 * `policy` to sign again with Kokoah's current builder and standard fee, checked like any policy (the address is
 * lowercased, a builder no policy can name is refused here). A policy with no builder requirement is returned as it
 * is; nothing else changes.
 */
export function withCurrentBuilder(policy: Policy, builder: CurrentBuilder): Policy {
  checkFee(builder);
  if (!policy.requiredBuilder) return policy;
  return parsePolicy({ ...policy, requiredBuilder: { b: builder.address, f: builder.feeTenthsBps } });
}
