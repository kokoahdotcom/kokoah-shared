import { readFileSync } from "node:fs";
import { MarketRegistry } from "../src/markets/index.js";

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
}

let cached: MarketRegistry | undefined;
/** Registry built from the captured mainnet fixtures (all perp dexes + spot + annotations). */
export function mainnetRegistry(): MarketRegistry {
  cached ??= MarketRegistry.fromInfo({
    allPerpMetas: fixture("mainnet-allPerpMetas.json"),
    perpDexs: fixture("mainnet-perpDexs.json"),
    spotMeta: fixture("mainnet-spotMeta.json"),
    annotations: fixture("mainnet-perpConciseAnnotations.json"),
  });
  return cached;
}

/** Deterministic PRNG for property-style tests. */
export function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
