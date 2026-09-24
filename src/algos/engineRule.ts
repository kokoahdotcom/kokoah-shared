/**
 * Everything the guardian engine runs: the guardian rules of `guardians` plus the algo rules defined here (`twap`).
 * {@link parseEngineRule} and {@link evaluateEngineRule} dispatch on `type`, so the engine and the API accept both
 * without changing the guardian types.
 *
 * @module
 */
import { evaluateRule, type GuardianEvaluation, type MarketState, type PositionState } from "../guardians/evaluate.js";
import { parseGuardianRule, type GuardianRule } from "../guardians/schemas.js";
import { evaluateTrailingStop, type ExecutionPlan } from "./trailing.js";
import { evaluateTwapRule, parseTwapRule, type TwapEvaluation, type TwapRule } from "./twapRule.js";

/** Algo rule types the guardian engine runs. */
export const ALGO_RULE_TYPES = ["twap"] as const;
export type AlgoRuleType = (typeof ALGO_RULE_TYPES)[number];

/** Any rule the guardian engine runs. */
export type EngineRule = GuardianRule | TwapRule;
/** Evaluation of any engine rule. `requires` and `cleanup` (see `ExecutionPlan`) say how to send the intents. */
export type EngineEvaluation = (GuardianEvaluation | TwapEvaluation) & Partial<Pick<ExecutionPlan, "requires" | "cleanup">>;

/** True for algo rules (listed apart from guardians in the app). */
export function isAlgoRule(rule: { type: string }): rule is TwapRule {
  return (ALGO_RULE_TYPES as readonly string[]).includes(rule.type);
}

/** Validates a guardian or algo rule by its `type`; throws `GuardianRuleValidationError`. */
export function parseEngineRule(input: unknown): EngineRule {
  const type = (input as { type?: unknown } | null)?.type;
  return type === "twap" ? parseTwapRule(input) : parseGuardianRule(input);
}

/**
 * Evaluates a guardian or algo rule (pure). TWAPs use `evaluateTwapRule`, trailing stops `evaluateTrailingStop`
 * (place-then-cancel moves and a restored stop), every other guardian `evaluateRule`.
 */
export function evaluateEngineRule(rule: EngineRule, market: MarketState, positions: PositionState, now: number): EngineEvaluation {
  if (rule.type === "twap") return evaluateTwapRule(rule, market, positions, now);
  if (rule.type === "trailingStop") return evaluateTrailingStop(rule, market, positions, now);
  return evaluateRule(rule, market, positions, now);
}
