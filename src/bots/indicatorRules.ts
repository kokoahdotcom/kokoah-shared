/**
 * Rules of the indicator signal bot: conditions on the chart's indicators, read at each candle close. The server and
 * the backtest decide with the same code, from the same candles.
 *
 * - An **operand** is a series: the close, a fixed number, or an indicator line (RSI 14, EMA 200, the upper Bollinger
 *   band…), computed as the chart computes it (`../indicators`).
 * - A **condition** compares two operands at a close (`above`, `below`, `crossesAbove`, `crossesBelow`: TradingView's
 *   `ta.crossover`, so the previous close was at or below) or reads a trend line's side (Supertrend or Parabolic SAR:
 *   `turnsUp`, `turnsDown`, `isUp`, `isDown`).
 * - A **rule** is up to {@link INDICATOR_LIMITS.maxConditions} conditions, all or any of them, and an action: buy, sell
 *   or close. A rule **fires** at the close where its conditions become true (they were not at the close before), so a
 *   condition that stays true acts once, and again only after it stopped being true.
 * - At one close: a close fires first; then one buy or one sell. A buy and a sell firing together cancel out.
 *
 * A value that needs more history than there is is unknown, and a rule that depends on it neither fires nor counts as
 * false at the next close (it never fires on the first close it can be read).
 *
 * @module
 */
import * as v from "valibot";
import { atr, bollinger, cci, dmi, donchian, ema, ICHIMOKU_SHIFT, ichimoku, keltner, macd, mfi, parabolicSar, rsi, sma, stochastic, stochRsi, supertrend, vwap, williamsR, type Hlcv, type Values } from "../indicators/index.js";

/** The candle lengths the bot reads (1m is too noisy to act on, and every close would be read late). */
export const INDICATOR_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;
export type IndicatorTimeframe = (typeof INDICATOR_TIMEFRAMES)[number];
export const INDICATOR_TIMEFRAME_MS: Readonly<Record<IndicatorTimeframe, number>> = Object.freeze({
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 3_600_000,
  "4h": 4 * 3_600_000,
  "1d": 86_400_000,
});

export const INDICATOR_LIMITS = Object.freeze({
  maxRules: 4,
  maxConditions: 5,
  /** Longest moving average or other length. */
  maxLength: 500,
  /** Most candles read to compute the indicators at a close. */
  maxBars: 1000,
  minBars: 50,
});

const finite = v.pipe(v.number(), v.finite());
const length = (fallback: number, max: number = INDICATOR_LIMITS.maxLength) => v.optional(v.pipe(v.number(), v.integer("Must be a whole number"), v.minValue(2), v.maxValue(max)), fallback);
const band = v.picklist(["upper", "middle", "lower"]);

const SupertrendSchema = v.strictObject({ kind: v.literal("supertrend"), length: length(10, 100), factor: v.optional(v.pipe(finite, v.minValue(0.5), v.maxValue(10)), 3) });
const SarSchema = v.strictObject({ kind: v.literal("sar") });

export const OperandSchema = v.variant("kind", [
  /** The candle's close. */
  v.strictObject({ kind: v.literal("price") }),
  v.strictObject({ kind: v.literal("value"), value: finite }),
  v.strictObject({ kind: v.literal("sma"), length: v.pipe(v.number(), v.integer("Must be a whole number"), v.minValue(2), v.maxValue(INDICATOR_LIMITS.maxLength)) }),
  v.strictObject({ kind: v.literal("ema"), length: v.pipe(v.number(), v.integer("Must be a whole number"), v.minValue(2), v.maxValue(INDICATOR_LIMITS.maxLength)) }),
  v.strictObject({ kind: v.literal("rsi"), length: length(14, 100) }),
  v.strictObject({ kind: v.literal("macd"), line: v.picklist(["macd", "signal", "hist"]), fast: length(12, 100), slow: length(26, 200), signal: length(9, 100) }),
  v.strictObject({ kind: v.literal("bb"), line: band, length: length(20, 200), mult: v.optional(v.pipe(finite, v.minValue(0.5), v.maxValue(5)), 2) }),
  v.strictObject({ kind: v.literal("kc"), line: band, length: length(20, 200), mult: v.optional(v.pipe(finite, v.minValue(0.5), v.maxValue(5)), 2) }),
  v.strictObject({ kind: v.literal("dc"), line: band, length: length(20, 200) }),
  v.strictObject({ kind: v.literal("stoch"), line: v.picklist(["k", "d"]), length: length(14, 100) }),
  v.strictObject({ kind: v.literal("stochRsi"), line: v.picklist(["k", "d"]) }),
  v.strictObject({ kind: v.literal("cci"), length: length(20, 200) }),
  v.strictObject({ kind: v.literal("wpr"), length: length(14, 200) }),
  v.strictObject({ kind: v.literal("mfi"), length: length(14, 100) }),
  v.strictObject({ kind: v.literal("atr"), length: length(14, 100) }),
  v.strictObject({ kind: v.literal("adx"), line: v.picklist(["adx", "plus", "minus"]), length: length(14, 100) }),
  v.strictObject({ kind: v.literal("vwap") }),
  SupertrendSchema,
  SarSchema,
  /** Ichimoku's lines at the close as the chart shows them there: the spans are the ones led 25 bars ahead to it. */
  v.strictObject({ kind: v.literal("ichimoku"), line: v.picklist(["tenkan", "kijun", "spanA", "spanB"]) }),
]);
export type IndicatorOperand = v.InferOutput<typeof OperandSchema>;
export type IndicatorOperandInput = v.InferInput<typeof OperandSchema>;
export type TrendOperand = Extract<IndicatorOperand, { kind: "supertrend" | "sar" }>;

export const COMPARE_OPS = ["above", "below", "crossesAbove", "crossesBelow"] as const;
export const TREND_OPS = ["turnsUp", "turnsDown", "isUp", "isDown"] as const;

export const ConditionSchema = v.variant("op", [
  v.strictObject({ op: v.picklist(COMPARE_OPS), left: OperandSchema, right: OperandSchema }),
  v.strictObject({ op: v.picklist(TREND_OPS), trend: v.variant("kind", [SupertrendSchema, SarSchema]) }),
]);
export type IndicatorCondition = v.InferOutput<typeof ConditionSchema>;

export const INDICATOR_ACTIONS = ["buy", "sell", "close"] as const;
export type IndicatorAction = (typeof INDICATOR_ACTIONS)[number];

export const RuleSchema = v.strictObject({
  action: v.picklist(INDICATOR_ACTIONS),
  /** `all`: every condition at once; `any`: at least one. */
  match: v.optional(v.picklist(["all", "any"]), "all"),
  conditions: v.pipe(v.array(ConditionSchema), v.minLength(1, "A rule needs a condition"), v.maxLength(INDICATOR_LIMITS.maxConditions)),
});
export type IndicatorRule = v.InferOutput<typeof RuleSchema>;

export const RulesSchema = v.pipe(v.array(RuleSchema), v.minLength(1, "Add a rule"), v.maxLength(INDICATOR_LIMITS.maxRules));

/** Problems of rules on a timeframe (empty when valid). */
export function indicatorRuleProblems(rules: readonly IndicatorRule[], timeframe: IndicatorTimeframe): string[] {
  const p: string[] = [];
  const operands = rules.flatMap((r) => r.conditions.flatMap((c) => ("trend" in c ? [c.trend] : [c.left, c.right])));
  if (timeframe === "1d" && operands.some((o) => o.kind === "vwap")) p.push("VWAP restarts every day: use it on candles shorter than a day.");
  for (const r of rules) {
    for (const c of r.conditions) {
      if ("trend" in c) continue;
      if (c.left.kind === "value" && c.right.kind === "value") p.push("A condition must read the chart: compare an indicator or the price, not two numbers.");
      else if (JSON.stringify(c.left) === JSON.stringify(c.right)) p.push("A condition compares a line with itself.");
    }
  }
  return [...new Set(p)];
}

// ------------------------------------------------------------------------------------------------ candles

/** Closed candles as numbers, oldest first, one `stepMs` apart. */
export interface IndicatorBars extends Hlcv {
  /** Open times (ms). */
  t: readonly number[];
  o: readonly number[];
  stepMs: number;
}

/** Candles in Hyperliquid's shape (prices as strings or numbers) as {@link IndicatorBars}. */
export function indicatorBars(rows: ReadonlyArray<{ t: number; o: string | number; h: string | number; l: string | number; c: string | number; v: string | number }>, stepMs: number): IndicatorBars {
  return {
    t: rows.map((r) => r.t),
    o: rows.map((r) => Number(r.o)),
    h: rows.map((r) => Number(r.h)),
    l: rows.map((r) => Number(r.l)),
    c: rows.map((r) => Number(r.c)),
    v: rows.map((r) => Number(r.v)),
    stepMs,
  };
}

/** Candles an operand needs before its value settles (moving averages seeded long enough ago to match the chart). */
function warmup(o: IndicatorOperand, stepMs: number): number {
  switch (o.kind) {
    case "price":
    case "value":
      return 2;
    case "sma":
    case "bb":
    case "dc":
    case "cci":
    case "wpr":
      return o.length;
    case "mfi":
      return o.length + 1;
    case "ema":
      return o.length * 4;
    case "rsi":
    case "atr":
    case "supertrend":
      return o.length * 5;
    case "macd":
      return Math.max(o.fast, o.slow) * 4 + o.signal * 4;
    case "kc":
      return Math.max(o.length * 4, 50);
    case "stoch":
      return o.length + 6;
    case "stochRsi":
      return 14 * 5 + 20;
    case "adx":
      return o.length * 10;
    case "vwap":
      // Since the day's start.
      return Math.ceil(86_400_000 / stepMs) + 1;
    case "sar":
      return 200;
    case "ichimoku":
      return 52 + ICHIMOKU_SHIFT + 2;
  }
}

/** The operands the rules read. */
export function ruleOperands(rules: readonly IndicatorRule[]): IndicatorOperand[] {
  return rules.flatMap((r) => r.conditions.flatMap((c) => ("trend" in c ? [c.trend] : [c.left, c.right])));
}

/** How many closed candles to read at a close (and before a backtest's first one): the longest warm-up, bounded. */
export function indicatorBarsNeeded(rules: readonly IndicatorRule[], timeframe: IndicatorTimeframe): number {
  const stepMs = INDICATOR_TIMEFRAME_MS[timeframe];
  const most = Math.max(0, ...ruleOperands(rules).map((o) => warmup(o, stepMs)));
  return Math.min(INDICATOR_LIMITS.maxBars, Math.max(INDICATOR_LIMITS.minBars, most + 2));
}

// ------------------------------------------------------------------------------------------------ reading

const key = (o: object) => JSON.stringify(o);

/** The series of the rules' operands over a set of candles, computed once each. */
export class IndicatorReader {
  readonly bars: IndicatorBars;
  private readonly cache = new Map<string, Values>();
  private readonly trends = new Map<string, (boolean | undefined)[]>();

  constructor(bars: IndicatorBars) {
    this.bars = bars;
  }

  get length(): number {
    return this.bars.c.length;
  }

  /** An operand's value at candle `i` (undefined: not enough history, or out of range). */
  value(o: IndicatorOperand, i: number): number | undefined {
    if (i < 0 || i >= this.length) return undefined;
    if (o.kind === "value") return o.value;
    if (o.kind === "price") return this.bars.c[i];
    const x = this.series(o)[i];
    return x === undefined || !Number.isFinite(x) ? undefined : x;
  }

  /** Whether a trend line is on its up side at candle `i` (undefined while it has no value yet). */
  up(o: TrendOperand, i: number): boolean | undefined {
    if (i < 0 || i >= this.length) return undefined;
    const k = key(o);
    let s = this.trends.get(k);
    if (!s) {
      if (o.kind === "supertrend") {
        const st = supertrend(this.bars, o.length, o.factor);
        s = st.up.map((u, j) => (st.value[j] === undefined ? undefined : u));
      } else {
        const ps = parabolicSar(this.bars);
        s = ps.up.map((u, j) => (ps.sar[j] === undefined ? undefined : u));
      }
      this.trends.set(k, s);
    }
    return s[i];
  }

  private series(o: Exclude<IndicatorOperand, { kind: "price" | "value" }>): Values {
    const k = key(o);
    const hit = this.cache.get(k);
    if (hit) return hit;
    const b = this.bars;
    let s: Values;
    switch (o.kind) {
      case "sma":
        s = sma(b.c, o.length);
        break;
      case "ema":
        s = ema(b.c, o.length);
        break;
      case "rsi":
        s = rsi(b.c, o.length);
        break;
      case "macd": {
        const m = macd(b.c, o.fast, o.slow, o.signal);
        s = o.line === "macd" ? m.line : o.line === "signal" ? m.signal : m.hist;
        break;
      }
      case "bb":
        s = bollinger(b.c, o.length, o.mult)[o.line];
        break;
      case "kc":
        s = keltner(b, o.length, o.mult)[o.line];
        break;
      case "dc":
        s = donchian(b, o.length)[o.line];
        break;
      case "stoch":
        s = stochastic(b.c, b.h, b.l, o.length)[o.line];
        break;
      case "stochRsi":
        s = stochRsi(b.c)[o.line];
        break;
      case "cci":
        s = cci(b, o.length);
        break;
      case "wpr":
        s = williamsR(b, o.length);
        break;
      case "mfi":
        s = mfi(b, o.length);
        break;
      case "atr":
        s = atr(b, o.length);
        break;
      case "adx":
        s = dmi(b, o.length, o.length)[o.line];
        break;
      case "vwap":
        s = vwap(b.t, b, b.stepMs);
        break;
      case "supertrend":
        s = supertrend(b, o.length, o.factor).value;
        break;
      case "sar":
        s = parabolicSar(b).sar;
        break;
      case "ichimoku": {
        const ich = ichimoku(b)[o.line];
        // The spans the chart shows at a candle were computed ICHIMOKU_SHIFT candles before it.
        s = o.line === "spanA" || o.line === "spanB" ? ich.map((_, i) => (i >= ICHIMOKU_SHIFT ? ich[i - ICHIMOKU_SHIFT] : undefined)) : ich;
        break;
      }
    }
    this.cache.set(k, s);
    return s;
  }

  /** Whether a condition holds at candle `i` (undefined: a value it needs is unknown). */
  condition(c: IndicatorCondition, i: number): boolean | undefined {
    if ("trend" in c) {
      const now = this.up(c.trend, i);
      if (now === undefined) return undefined;
      if (c.op === "isUp") return now;
      if (c.op === "isDown") return !now;
      const before = this.up(c.trend, i - 1);
      if (before === undefined) return undefined;
      return c.op === "turnsUp" ? now && !before : !now && before;
    }
    const [l, r] = [this.value(c.left, i), this.value(c.right, i)];
    if (l === undefined || r === undefined) return undefined;
    if (c.op === "above") return l > r;
    if (c.op === "below") return l < r;
    const [pl, pr] = [this.value(c.left, i - 1), this.value(c.right, i - 1)];
    if (pl === undefined || pr === undefined) return undefined;
    return c.op === "crossesAbove" ? l > r && pl <= pr : l < r && pl >= pr;
  }

  /** Whether a rule's conditions hold at candle `i` (all or any of them; undefined when that depends on an unknown). */
  rule(r: IndicatorRule, i: number): boolean | undefined {
    const results = r.conditions.map((c) => this.condition(c, i));
    if (r.match === "any") return results.some((x) => x === true) ? true : results.some((x) => x === undefined) ? undefined : false;
    return results.some((x) => x === false) ? false : results.some((x) => x === undefined) ? undefined : true;
  }
}

export interface IndicatorDecision {
  /** The rules (by index) whose conditions became true at this close. */
  fired: number[];
  /** What the bot does, in order: a close first, then one buy or one sell. */
  actions: IndicatorAction[];
  /** A buy rule and a sell rule fired together: neither acts. */
  conflict: boolean;
  /** A value some rule needs is unknown yet (not enough history). */
  warming: boolean;
}

/** What the rules decide at the close of candle `i`. */
export function indicatorDecision(rules: readonly IndicatorRule[], reader: IndicatorReader, i: number): IndicatorDecision {
  const fired: number[] = [];
  let warming = false;
  rules.forEach((r, k) => {
    const now = reader.rule(r, i);
    if (now === undefined) warming = true;
    if (now === true && reader.rule(r, i - 1) === false) fired.push(k);
  });
  const did = (a: IndicatorAction) => fired.some((k) => rules[k]!.action === a);
  const conflict = did("buy") && did("sell");
  const actions: IndicatorAction[] = [];
  if (did("close")) actions.push("close");
  if (!conflict && did("buy")) actions.push("buy");
  if (!conflict && did("sell")) actions.push("sell");
  return { fired, actions, conflict, warming };
}

// ------------------------------------------------------------------------------------------------ words

const fmt = (x: number) => (Number.isInteger(x) ? String(x) : String(Number(x.toPrecision(6))));
const BAND = { upper: "upper", middle: "middle", lower: "lower" } as const;

/** An operand in a few words (English; the app and notifications have their own translations). */
export function operandLabel(o: IndicatorOperand): string {
  switch (o.kind) {
    case "price":
      return "Price";
    case "value":
      return fmt(o.value);
    case "sma":
      return `SMA(${o.length})`;
    case "ema":
      return `EMA(${o.length})`;
    case "rsi":
      return `RSI(${o.length})`;
    case "macd":
      return `${o.line === "macd" ? "MACD" : o.line === "signal" ? "MACD signal" : "MACD histogram"} (${o.fast}, ${o.slow}, ${o.signal})`;
    case "bb":
      return `Bollinger ${BAND[o.line]} (${o.length}, ${fmt(o.mult)})`;
    case "kc":
      return `Keltner ${BAND[o.line]} (${o.length}, ${fmt(o.mult)})`;
    case "dc":
      return `Donchian ${BAND[o.line]} (${o.length})`;
    case "stoch":
      return `Stochastic %${o.line.toUpperCase()} (${o.length})`;
    case "stochRsi":
      return `Stoch RSI %${o.line.toUpperCase()}`;
    case "cci":
      return `CCI(${o.length})`;
    case "wpr":
      return `Williams %R (${o.length})`;
    case "mfi":
      return `MFI(${o.length})`;
    case "atr":
      return `ATR(${o.length})`;
    case "adx":
      return `${o.line === "adx" ? "ADX" : o.line === "plus" ? "+DI" : "−DI"}(${o.length})`;
    case "vwap":
      return "VWAP";
    case "supertrend":
      return `Supertrend (${o.length}, ${fmt(o.factor)})`;
    case "sar":
      return "Parabolic SAR";
    case "ichimoku":
      return `Ichimoku ${o.line === "tenkan" ? "conversion line" : o.line === "kijun" ? "base line" : o.line === "spanA" ? "span A" : "span B"}`;
  }
}

/** A condition in plain words ("RSI(14) crosses below 30"). */
export function conditionText(c: IndicatorCondition): string {
  if ("trend" in c) {
    const name = operandLabel(c.trend);
    return `${name} ${c.op === "turnsUp" ? "turns up" : c.op === "turnsDown" ? "turns down" : c.op === "isUp" ? "is up" : "is down"}`;
  }
  const op = c.op === "above" ? "is above" : c.op === "below" ? "is below" : c.op === "crossesAbove" ? "crosses above" : "crosses below";
  return `${operandLabel(c.left)} ${op} ${operandLabel(c.right)}`;
}

/** A rule in plain words ("Buy when RSI(14) crosses below 30 and Price is above EMA(200)"). */
export function ruleText(r: IndicatorRule): string {
  const verb = r.action === "buy" ? "Buy" : r.action === "sell" ? "Sell" : "Close";
  return `${verb} when ${r.conditions.map(conditionText).join(r.match === "any" ? " or " : " and ")}`;
}
