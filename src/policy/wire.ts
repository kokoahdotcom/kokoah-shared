/**
 * Strict structural validation of HL wire actions received by a signer. Policy evaluation fails closed on anything
 * that does not have exactly the shape `compileAction` produces: malformed numbers must never turn a limit check into
 * `NaN > limit === false`.
 *
 * @module
 */

const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CLOID = /^0x[0-9a-fA-F]{32}$/;
const TIFS = new Set(["Gtc", "Ioc", "Alo", "FrontendMarket"]);

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isUint(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}
/** Positive decimal string as HL expects on the wire (no sign, no exponent). */
export function isPositiveDecimalString(v: unknown): v is string {
  return typeof v === "string" && DECIMAL.test(v) && Number(v) > 0 && Number.isFinite(Number(v));
}
export function isAddress(v: unknown): v is string {
  return typeof v === "string" && ADDRESS.test(v);
}

/** Hyperliquid's whole-position size: exactly "0" on the wire. */
export const WHOLE_POSITION_SIZE = "0";

/**
 * True when an order wire is a whole-position TP/SL: size exactly "0", reduce-only, a stop or take-profit trigger.
 * Hyperliquid's own app sends a TP/SL for the entire position this way (grouping `positionTpsl`); it closes whatever is
 * open when it fires. Only {@link wireActionProblems} decides where one may appear.
 */
export function isWholePositionWire(o: unknown): boolean {
  return isReduceOnlyExitWire(o) && (o as Rec).s === WHOLE_POSITION_SIZE;
}

/** A reduce-only stop or take-profit trigger order wire. */
function isReduceOnlyExitWire(o: unknown): boolean {
  if (!isRec(o) || o.r !== true || !isRec(o.t)) return false;
  const tr = o.t.trigger;
  return isRec(tr) && (tr.tpsl === "tp" || tr.tpsl === "sl");
}

/**
 * Problems with one order wire (`{a, b, p, s, r, t, c?}`). The size must be positive, except a whole-position TP/SL
 * ({@link isWholePositionWire}) where `wholePosition` allows it: a position TP/SL order action of exits only, or a
 * modify (whose target the policy checks is a whole-position TP/SL).
 */
export function orderWireProblems(o: unknown, where: string, wholePosition = false): string[] {
  if (!isRec(o)) return [`${where}: order must be an object`];
  const p: string[] = [];
  if (!isUint(o.a)) p.push(`${where}: asset "a" must be a non-negative integer`);
  if (typeof o.b !== "boolean") p.push(`${where}: "b" must be a boolean`);
  if (!isPositiveDecimalString(o.p)) p.push(`${where}: price "p" must be a positive decimal string`);
  if (!isPositiveDecimalString(o.s) && !(wholePosition && isWholePositionWire(o))) {
    p.push(
      o.s === WHOLE_POSITION_SIZE
        ? `${where}: size "0" is allowed only for a reduce-only TP/SL for the whole position`
        : `${where}: size "s" must be a positive decimal string`,
    );
  }
  if (typeof o.r !== "boolean") p.push(`${where}: "r" must be a boolean`);
  if (o.c !== undefined && !(typeof o.c === "string" && CLOID.test(o.c))) p.push(`${where}: cloid "c" is malformed`);
  const t = o.t;
  if (!isRec(t)) {
    p.push(`${where}: "t" must be an object`);
  } else {
    const keys = Object.keys(t);
    if (keys.length !== 1 || (keys[0] !== "limit" && keys[0] !== "trigger")) p.push(`${where}: "t" must be {limit} or {trigger}`);
    else if (keys[0] === "limit") {
      if (!isRec(t.limit) || typeof t.limit.tif !== "string" || !TIFS.has(t.limit.tif)) p.push(`${where}: invalid limit tif`);
    } else {
      const tr = t.trigger;
      if (!isRec(tr) || typeof tr.isMarket !== "boolean" || !isPositiveDecimalString(tr.triggerPx) || (tr.tpsl !== "tp" && tr.tpsl !== "sl")) {
        p.push(`${where}: invalid trigger`);
      }
    }
  }
  const allowed = new Set(["a", "b", "p", "s", "r", "t", "c"]);
  for (const k of Object.keys(o)) if (!allowed.has(k)) p.push(`${where}: unexpected key "${k}"`);
  return p;
}

/** Problems with a wire action of an allow-listable type. Unknown/denied types are handled by the policy itself. */
export function wireActionProblems(w: Rec): string[] {
  const p: string[] = [];
  const oid = (v: unknown) => isUint(v) || (typeof v === "string" && CLOID.test(v));
  switch (w.type) {
    case "order": {
      if (!Array.isArray(w.orders) || w.orders.length === 0) return ["order action needs a non-empty orders array"];
      // Size 0 only in a position TP/SL action of exits alone (Hyperliquid's TP/SL for the whole position, as its own
      // app sends it: a take profit, a stop loss or both), never next to an entry.
      const exitsOnly = w.grouping === "positionTpsl" && w.orders.every((o) => isReduceOnlyExitWire(o));
      w.orders.forEach((o, i) => p.push(...orderWireProblems(o, `orders[${i}]`, exitsOnly)));
      const g = w.grouping;
      const groupingOk = g === undefined || g === "na" || g === "normalTpsl" || g === "positionTpsl" || (isRec(g) && isUint(g.p));
      if (!groupingOk) p.push("invalid grouping");
      if (w.builder !== undefined && !(isRec(w.builder) && isAddress(w.builder.b) && isUint(w.builder.f))) p.push("invalid builder");
      break;
    }
    case "modify":
      if (!oid(w.oid)) p.push("modify needs an oid (integer) or cloid");
      // Size 0 keeps a whole-position TP/SL whole; the policy checks the target is a position TP/SL.
      p.push(...orderWireProblems(w.order, "order", true));
      if (w.a !== undefined && w.a !== true) p.push('"a" must be omitted or true');
      break;
    case "batchModify":
      if (!Array.isArray(w.modifies) || w.modifies.length === 0) return ["batchModify needs a non-empty modifies array"];
      w.modifies.forEach((m, i) => {
        if (!isRec(m) || !oid(m.oid)) p.push(`modifies[${i}]: needs an oid or cloid`);
        else p.push(...orderWireProblems(m.order, `modifies[${i}].order`, true));
      });
      if (w.a !== undefined && w.a !== true) p.push('"a" must be omitted or true');
      break;
    case "cancel":
      if (!Array.isArray(w.cancels) || w.cancels.length === 0) return ["cancel needs a non-empty cancels array"];
      w.cancels.forEach((c, i) => {
        if (!isRec(c) || !isUint(c.a) || !isUint(c.o)) p.push(`cancels[${i}]: needs integer a and o`);
      });
      break;
    case "cancelByCloid":
      if (!Array.isArray(w.cancels) || w.cancels.length === 0) return ["cancelByCloid needs a non-empty cancels array"];
      w.cancels.forEach((c, i) => {
        if (!isRec(c) || !isUint(c.asset) || !(typeof c.cloid === "string" && CLOID.test(c.cloid))) p.push(`cancels[${i}]: needs integer asset and a cloid`);
      });
      break;
    case "updateLeverage":
      if (!isUint(w.asset) || typeof w.isCross !== "boolean" || !(isUint(w.leverage) && w.leverage >= 1)) p.push("updateLeverage needs integer asset, boolean isCross and integer leverage ≥ 1");
      break;
    case "updateIsolatedMargin":
      if (!isUint(w.asset) || typeof w.isBuy !== "boolean" || !(typeof w.ntli === "number" && Number.isSafeInteger(w.ntli) && w.ntli !== 0)) {
        p.push("updateIsolatedMargin needs integer asset, boolean isBuy and a non-zero integer ntli");
      }
      break;
    case "topUpIsolatedOnlyMargin":
      if (!isUint(w.asset) || !isPositiveDecimalString(w.leverage)) p.push("topUpIsolatedOnlyMargin needs integer asset and a decimal leverage");
      break;
    case "scheduleCancel":
      if (w.time !== undefined && !isUint(w.time)) p.push("scheduleCancel time must be an integer");
      break;
    case "noop":
      break;
    case "setReferrer":
      if (!(typeof w.code === "string" && /^[A-Za-z0-9_-]{1,20}$/.test(w.code))) p.push("setReferrer needs a code of 1-20 of A-Z a-z 0-9 _ -");
      p.push(...extraKeys(w, ["type", "code"]));
      break;
    case "startFeeTrial":
      for (const k of ["addBaseRate", "crossBaseRate"]) {
        const r = w[k];
        if (!(typeof r === "string" && /^-?[0-9]+\.[0-9]{1,8}$/.test(r) && Math.abs(Number(r)) < 1)) p.push(`startFeeTrial needs ${k} as a decimal fraction`);
      }
      p.push(...extraKeys(w, ["type", "addBaseRate", "crossBaseRate"]));
      break;
    default:
      break;
  }
  return p;
}

/** Problems for keys of `w` outside `allowed` (actions whose exact shape is small and fixed). */
function extraKeys(w: Rec, allowed: readonly string[]): string[] {
  return Object.keys(w)
    .filter((k) => !allowed.includes(k))
    .map((k) => `${String(w.type)}: unexpected key "${k}"`);
}
