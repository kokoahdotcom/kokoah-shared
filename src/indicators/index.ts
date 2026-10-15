/**
 * Technical indicators, as the chart draws them and the indicator bots read them: the same numbers in the browser and
 * on the server. Every function takes values oldest first and returns one value per input (undefined while there is
 * not enough history yet). The formulas follow TradingView's built-ins unless a comment says otherwise.
 *
 * @module
 */

export type Values = (number | undefined)[];

/** A candle series as numbers, oldest first. */
export interface Hlcv {
  h: readonly number[];
  l: readonly number[];
  c: readonly number[];
  v: readonly number[];
}

/** Simple moving average of the last `n` values (undefined until there are `n`). */
export function sma(values: readonly number[], n: number): Values {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n]!;
    return i >= n - 1 ? sum / n : undefined;
  });
}

/**
 * Exponential moving average (weight 2 / (n + 1)), seeded with the simple average of the first `n` defined values;
 * undefined inputs (a series that starts later, like MACD) are skipped.
 */
export function ema(values: readonly (number | undefined)[], n: number): Values {
  const k = 2 / (n + 1);
  const out: Values = [];
  let seen = 0;
  let sum = 0;
  let prev: number | undefined;
  for (const v of values) {
    if (v === undefined) {
      out.push(undefined);
      continue;
    }
    if (prev === undefined) {
      seen++;
      sum += v;
      if (seen === n) prev = sum / n;
      out.push(prev);
      continue;
    }
    prev = v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Bollinger Bands: the `n`-bar simple average and `mult` population standard deviations around it (TradingView's). */
export function bollinger(closes: readonly number[], n = 20, mult = 2) {
  const middle = sma(closes, n);
  const upper: Values = [];
  const lower: Values = [];
  closes.forEach((_, i) => {
    const m = middle[i];
    if (m === undefined) {
      upper.push(undefined);
      lower.push(undefined);
      return;
    }
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(sq / n);
    upper.push(m + mult * sd);
    lower.push(m - mult * sd);
  });
  return { upper, middle, lower };
}

/** Relative strength index with Wilder's smoothing (from the `n`+1th close). */
export function rsi(closes: readonly number[], n = 14): Values {
  const out: Values = closes.map(() => undefined);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i]! - closes[i - 1]!;
    const up = Math.max(change, 0);
    const down = Math.max(-change, 0);
    if (i <= n) {
      gain += up / n;
      loss += down / n;
      if (i < n) continue;
    } else {
      gain = (gain * (n - 1) + up) / n;
      loss = (loss * (n - 1) + down) / n;
    }
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

/** MACD: the fast minus the slow EMA, its signal EMA and the histogram between them. */
export function macd(closes: readonly number[], fast = 12, slow = 26, signalLength = 9) {
  const f = ema(closes, fast);
  const s = ema(closes, slow);
  const line: Values = closes.map((_, i) => (f[i] !== undefined && s[i] !== undefined ? f[i]! - s[i]! : undefined));
  const signal = ema(line, signalLength);
  const hist: Values = line.map((v, i) => (v !== undefined && signal[i] !== undefined ? v - signal[i]! : undefined));
  return { line, signal, hist };
}

/**
 * VWAP of the typical price, for bars opened at `times` (ms) and `stepMs` long. Intraday intervals restart it at 00:00
 * UTC each day (a session VWAP, as exchanges show it); daily and longer bars accumulate from the first bar.
 */
export function vwap(times: readonly number[], bars: Hlcv, stepMs: number): Values {
  let pv = 0;
  let volume = 0;
  let day = NaN;
  return times.map((t, i) => {
    const d = Math.floor(t / 86_400_000);
    if (stepMs < 86_400_000 && d !== day) {
      day = d;
      pv = 0;
      volume = 0;
    }
    const typical = (bars.h[i]! + bars.l[i]! + bars.c[i]!) / 3;
    pv += typical * bars.v[i]!;
    volume += bars.v[i]!;
    return volume > 0 ? pv / volume : bars.c[i]!;
  });
}

/** Simple moving average over values that start later (undefined until `n` defined values in a row). */
export function smaOf(values: readonly (number | undefined)[], n: number): Values {
  const out: Values = [];
  let run: number[] = [];
  for (const v of values) {
    if (v === undefined) {
      run = [];
      out.push(undefined);
      continue;
    }
    run.push(v);
    if (run.length > n) run.shift();
    out.push(run.length === n ? run.reduce((a, b) => a + b, 0) / n : undefined);
  }
  return out;
}

/** Wilder's moving average (TradingView's `rma`): seeded with the simple average of the first `n` defined values. */
export function rma(values: readonly (number | undefined)[], n: number): Values {
  const out: Values = [];
  let seen = 0;
  let sum = 0;
  let prev: number | undefined;
  for (const v of values) {
    if (v === undefined) {
      out.push(prev === undefined ? undefined : prev);
      continue;
    }
    if (prev === undefined) {
      seen++;
      sum += v;
      if (seen === n) prev = sum / n;
      out.push(prev);
      continue;
    }
    prev = (prev * (n - 1) + v) / n;
    out.push(prev);
  }
  return out;
}

/** Highest and lowest of the last `n` values (undefined until there are `n`). */
function rolling(values: readonly (number | undefined)[], n: number, pick: (a: number, b: number) => number): Values {
  return values.map((_, i) => {
    if (i < n - 1) return undefined;
    let best: number | undefined;
    for (let j = i - n + 1; j <= i; j++) {
      const v = values[j];
      if (v === undefined) return undefined;
      best = best === undefined ? v : pick(best, v);
    }
    return best;
  });
}
export const highest = (values: readonly (number | undefined)[], n: number) => rolling(values, n, Math.max);
export const lowest = (values: readonly (number | undefined)[], n: number) => rolling(values, n, Math.min);

/** True range: the bar's range, widened to the previous close. */
export function trueRange({ h, l, c }: Hlcv): number[] {
  return h.map((high, i) => (i === 0 ? high - l[i]! : Math.max(high - l[i]!, Math.abs(high - c[i - 1]!), Math.abs(l[i]! - c[i - 1]!))));
}
export const atr = (bars: Hlcv, n = 14) => rma(trueRange(bars), n);

/** Stochastic %K (smoothed) and %D of `source` against its own `n`-bar high and low (the close against the bars'). */
export function stochastic(source: readonly (number | undefined)[], high: readonly (number | undefined)[], low: readonly (number | undefined)[], n = 14, smoothK = 3, smoothD = 3) {
  const hh = highest(high, n);
  const ll = lowest(low, n);
  const raw: Values = source.map((v, i) => {
    const [top, bottom] = [hh[i], ll[i]];
    if (v === undefined || top === undefined || bottom === undefined) return undefined;
    return top === bottom ? 50 : (100 * (v - bottom)) / (top - bottom);
  });
  const k = smaOf(raw, smoothK);
  return { k, d: smaOf(k, smoothD) };
}

/** Stochastic RSI: the stochastic of RSI (14) over 14 bars, smoothed 3 and 3. */
export function stochRsi(closes: readonly number[], rsiLength = 14, n = 14, smoothK = 3, smoothD = 3) {
  const r = rsi(closes, rsiLength);
  return stochastic(r, r, r, n, smoothK, smoothD);
}

/** Williams %R: where the close sits in the `n`-bar range, from −100 (low) to 0 (high). */
export function williamsR({ h, l, c }: Hlcv, n = 14): Values {
  const hh = highest(h, n);
  const ll = lowest(l, n);
  return c.map((close, i) => {
    const [top, bottom] = [hh[i], ll[i]];
    if (top === undefined || bottom === undefined) return undefined;
    return top === bottom ? -50 : (-100 * (top - close)) / (top - bottom);
  });
}

/** Commodity Channel Index of the typical price, with the mean absolute deviation. */
export function cci({ h, l, c }: Hlcv, n = 20): Values {
  const tp = c.map((close, i) => (h[i]! + l[i]! + close) / 3);
  const mean = sma(tp, n);
  return tp.map((v, i) => {
    const m = mean[i];
    if (m === undefined) return undefined;
    let dev = 0;
    for (let j = i - n + 1; j <= i; j++) dev += Math.abs(tp[j]! - m);
    dev /= n;
    return dev === 0 ? 0 : (v - m) / (0.015 * dev);
  });
}

/** Money Flow Index: RSI-like, of the typical price times volume. */
export function mfi({ h, l, c, v }: Hlcv, n = 14): Values {
  const tp = c.map((close, i) => (h[i]! + l[i]! + close) / 3);
  return tp.map((_, i) => {
    if (i < n) return undefined;
    let up = 0;
    let down = 0;
    for (let j = i - n + 1; j <= i; j++) {
      const flow = tp[j]! * v[j]!;
      if (tp[j]! > tp[j - 1]!) up += flow;
      else if (tp[j]! < tp[j - 1]!) down += flow;
    }
    return down === 0 ? (up === 0 ? 50 : 100) : 100 - 100 / (1 + up / down);
  });
}

/** On-balance volume: volume added on up closes and taken away on down closes. */
export function obv({ c, v }: Hlcv): number[] {
  let total = 0;
  return c.map((close, i) => {
    if (i > 0) total += close > c[i - 1]! ? v[i]! : close < c[i - 1]! ? -v[i]! : 0;
    return total;
  });
}

/** Directional movement: +DI, −DI and ADX, all with Wilder's smoothing (TradingView's DMI). */
export function dmi(bars: Hlcv, n = 14, adxLength = 14) {
  const { h, l } = bars;
  const plusDm = h.map((high, i) => {
    if (i === 0) return undefined;
    const up = high - h[i - 1]!;
    const down = l[i - 1]! - l[i]!;
    return up > down && up > 0 ? up : 0;
  });
  const minusDm = h.map((high, i) => {
    if (i === 0) return undefined;
    const up = high - h[i - 1]!;
    const down = l[i - 1]! - l[i]!;
    return down > up && down > 0 ? down : 0;
  });
  const tr = rma(
    trueRange(bars).map((x, i) => (i === 0 ? undefined : x)),
    n,
  );
  const [pdm, mdm] = [rma(plusDm, n), rma(minusDm, n)];
  const plus: Values = tr.map((t, i) => (t && pdm[i] !== undefined ? (100 * pdm[i]!) / t : undefined));
  const minus: Values = tr.map((t, i) => (t && mdm[i] !== undefined ? (100 * mdm[i]!) / t : undefined));
  const dx: Values = plus.map((p, i) => {
    const m = minus[i];
    if (p === undefined || m === undefined) return undefined;
    return p + m === 0 ? 0 : Math.abs(p - m) / (p + m);
  });
  const adx = rma(dx, adxLength).map((x) => (x === undefined ? undefined : 100 * x));
  return { plus, minus, adx };
}

/** Parabolic SAR (start 0.02, step 0.02, max 0.2), and whether each bar is in an uptrend. */
export function parabolicSar({ h, l, c }: Hlcv, start = 0.02, step = 0.02, max = 0.2) {
  const sar: Values = h.map(() => undefined);
  const up: boolean[] = h.map(() => true);
  if (h.length < 2) return { sar, up };
  let long = c[1]! >= c[0]!;
  let af = start;
  let ep = long ? Math.max(h[0]!, h[1]!) : Math.min(l[0]!, l[1]!);
  let value = long ? Math.min(l[0]!, l[1]!) : Math.max(h[0]!, h[1]!);
  sar[1] = value;
  up[1] = long;
  for (let i = 2; i < h.length; i++) {
    value += af * (ep - value);
    if (long) {
      // Never above the last two lows.
      value = Math.min(value, l[i - 1]!, l[i - 2]!);
      if (l[i]! < value) {
        long = false;
        value = ep;
        ep = l[i]!;
        af = start;
      } else if (h[i]! > ep) {
        ep = h[i]!;
        af = Math.min(af + step, max);
      }
    } else {
      value = Math.max(value, h[i - 1]!, h[i - 2]!);
      if (h[i]! > value) {
        long = true;
        value = ep;
        ep = h[i]!;
        af = start;
      } else if (l[i]! < ep) {
        ep = l[i]!;
        af = Math.min(af + step, max);
      }
    }
    sar[i] = value;
    up[i] = long;
  }
  return { sar, up };
}

/**
 * Supertrend (ATR 10, factor 3), as TradingView computes it: bands `factor` ATRs from the bar's midpoint that only
 * tighten while the trend holds; the trend flips when the close crosses the band in force.
 */
export function supertrend(bars: Hlcv, n = 10, factor = 3) {
  const { h, l, c } = bars;
  const a = atr(bars, n);
  const value: Values = [];
  const up: boolean[] = [];
  let lower = 0;
  let upper = 0;
  let previous: number | undefined;
  let long = false;
  for (let i = 0; i < c.length; i++) {
    const range = a[i];
    if (range === undefined) {
      value.push(undefined);
      up.push(false);
      continue;
    }
    const mid = (h[i]! + l[i]!) / 2;
    const prevClose = c[i - 1] ?? c[i]!;
    let nextLower = mid - factor * range;
    let nextUpper = mid + factor * range;
    if (!(nextLower > lower || prevClose < lower)) nextLower = lower;
    if (!(nextUpper < upper || prevClose > upper)) nextUpper = upper;
    if (previous === undefined) long = false;
    else if (previous === upper) long = c[i]! > nextUpper;
    else long = !(c[i]! < nextLower);
    [lower, upper] = [nextLower, nextUpper];
    previous = long ? lower : upper;
    value.push(previous);
    up.push(long);
  }
  return { value, up };
}

/** Ichimoku (9, 26, 52, 26): conversion and base lines and the two spans, before the spans are led ahead. */
export function ichimoku({ h, l }: Pick<Hlcv, "h" | "l">, conversion = 9, base = 26, spanB = 52) {
  const mid = (n: number) => {
    const [hh, ll] = [highest(h, n), lowest(l, n)];
    return hh.map((x, i) => (x === undefined || ll[i] === undefined ? undefined : (x + ll[i]!) / 2));
  };
  const tenkan = mid(conversion);
  const kijun = mid(base);
  const spanA: Values = tenkan.map((x, i) => (x === undefined || kijun[i] === undefined ? undefined : (x + kijun[i]!) / 2));
  return { tenkan, kijun, spanA, spanB: mid(spanB) };
}
/** The spans are drawn this many bars ahead of the bar they are computed on (and the lagging line this many back). */
export const ICHIMOKU_SHIFT = 25;

/** Keltner Channels: EMA 20 of the close with 2 ATR (10) either side. */
export function keltner(bars: Hlcv, n = 20, mult = 2, atrLength = 10) {
  const middle = ema(bars.c, n);
  const range = atr(bars, atrLength);
  const side = (sign: number): Values => middle.map((m, i) => (m === undefined || range[i] === undefined ? undefined : m + sign * mult * range[i]!));
  return { upper: side(1), middle, lower: side(-1) };
}

/** Donchian Channels: the `n`-bar high, low and their middle. */
export function donchian({ h, l }: Pick<Hlcv, "h" | "l">, n = 20) {
  const [upper, lower] = [highest(h, n), lowest(l, n)];
  const middle: Values = upper.map((u, i) => (u === undefined || lower[i] === undefined ? undefined : (u + lower[i]!) / 2));
  return { upper, middle, lower };
}
