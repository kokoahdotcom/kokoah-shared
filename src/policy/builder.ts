/**
 * A signed policy's builder against Kokoah's current one. A policy caps the fee of every order at its `requiredBuilder.f`
 * (evaluate.ts), and Kokoah's signers attach the current standard fee. So when the standard fee rises, a policy signed
 * for the lower one refuses every order: it is outdated and must be signed again, like an expired one. A policy signed
 * for another builder address is outdated the same way. A policy with no builder requirement is never outdated by the
 * fee (the signers attach the current fee anyway).
 */
import type { Policy } from "./schema.js";

/** Kokoah's builder as the signers attach it: its address and its standard fee (tenths of a basis point). */
export interface CurrentBuilder {
  address: string;
  feeTenthsBps: number;
}

/**
 * Whether `policy` was signed for a builder fee below the current standard fee, or for another builder address: every
 * order under it would be refused (BUILDER_MISMATCH), so it must be signed again with {@link withCurrentBuilder}.
 */
export function policyBuilderOutdated(policy: Pick<Policy, "requiredBuilder">, builder: CurrentBuilder): boolean {
  const required = policy.requiredBuilder;
  if (!required) return false;
  return required.b.toLowerCase() !== builder.address.toLowerCase() || required.f < builder.feeTenthsBps;
}

/**
 * `policy` to sign again with Kokoah's current builder and standard fee. A policy with no builder requirement is
 * returned as it is; nothing else changes.
 */
export function withCurrentBuilder(policy: Policy, builder: CurrentBuilder): Policy {
  if (!policy.requiredBuilder) return policy;
  return { ...policy, requiredBuilder: { b: builder.address.toLowerCase() as `0x${string}`, f: builder.feeTenthsBps } };
}
