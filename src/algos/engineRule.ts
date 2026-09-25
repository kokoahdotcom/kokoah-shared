/**
 * Everything the guardian engine runs: the guardian rules of `guardians` plus the algo rules defined here (`twap`,
 * `bracket`, `chase`). {@link parseEngineRule} and {@link evaluateEngineRule} dispatch on `type`, so the engine and
 * the API accept both without changing the guardian types.
 *
 * @module
 */
import { evaluateRule, type GuardianEvaluation, type MarketState, type PositionState } from "../guardians/evaluate.js";
import { parseGuardianRule, type GuardianRule } from "../guardians/schemas.js";
import { bracketOrderRefs, evaluateBracketRule, parseBracketRule, type BracketEvaluation, type BracketRule } from "./bracketRule.js";
import { chaseOrderRefs, evaluateChaseRule, parseChaseRule, type ChaseEvaluation, type ChaseRule } from "./chaseRule.js";
import { evaluateTrailingStop, type ExecutionPlan } from "./trailing.js";
import { evaluateTwapRule, parseTwapRule, type AlgoEnv, type TwapEvaluation, type TwapRule } from "./twapRule.js";

/** Algo rule types the guardian engine runs (listed apart from guardians in the app). */
export const ALGO_RULE_TYPES = ["twap", "bracket", "chase"] as const;
export type AlgoRuleType = (typeof ALGO_RULE_TYPES)[number];

/** An algo rule. */
export type AlgoRule = TwapRule | BracketRule | ChaseRule;
/** Any rule the guardian engine runs. */
export type EngineRule = GuardianRule | AlgoRule;
/** Evaluation of any engine rule. `requires` and `cleanup` (see `ExecutionPlan`) say how to send the intents. */
export type EngineEvaluation = (GuardianEvaluation | TwapEvaluation | BracketEvaluation | ChaseEvaluation) & Partial<Pick<ExecutionPlan, "requires" | "cleanup">>;
export type { AlgoEnv };

/** True for algo rules (listed apart from guardians in the app). */
export function isAlgoRule(rule: { type: string }): rule is AlgoRule {
  return (ALGO_RULE_TYPES as readonly string[]).includes(rule.type);
}

/** Validates a guardian or algo rule by its `type`; throws `GuardianRuleValidationError`. */
export function parseEngineRule(input: unknown): EngineRule {
  const type = (input as { type?: unknown } | null)?.type;
  if (type === "twap") return parseTwapRule(input);
  if (type === "bracket") return parseBracketRule(input);
  if (type === "chase") return parseChaseRule(input);
  return parseGuardianRule(input);
}

/**
 * Evaluates a guardian or algo rule (pure). TWAPs use `evaluateTwapRule` (paused by `env.exchange`), brackets
 * `evaluateBracketRule`, chases `evaluateChaseRule`, trailing stops `evaluateTrailingStop` (place-then-cancel moves
 * and a restored stop), every other guardian `evaluateRule`.
 */
export function evaluateEngineRule(rule: EngineRule, market: MarketState, positions: PositionState, now: number, env: AlgoEnv = {}): EngineEvaluation {
  if (rule.type === "twap") return evaluateTwapRule(rule, market, positions, now, env);
  if (rule.type === "bracket") return evaluateBracketRule(rule, market, positions, now);
  if (rule.type === "chase") return evaluateChaseRule(rule, market, positions, now);
  if (rule.type === "trailingStop") return evaluateTrailingStop(rule, market, positions, now);
  return evaluateRule(rule, market, positions, now);
}

/** Orders an algo rule needs looked up by `orderStatus` (brackets and chases); empty for other rules. */
export function algoOrderRefs(rule: EngineRule, now: number): { oid?: number | undefined; cloid?: string | undefined }[] {
  if (rule.type === "bracket") return bracketOrderRefs(rule);
  if (rule.type === "chase") return chaseOrderRefs(rule, now);
  return [];
}
