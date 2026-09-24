/**
 * Client order ids (cloids): 128-bit hex strings `0x` + 32 lowercase hex characters
 * (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint).
 *
 * Kokoah layout (bytes): `[0x6b 0x6f][origin][version][12 random or derived bytes]`
 * - `0x6b6f` is ASCII "ko" and marks Kokoah-generated orders (useful for attribution and reconciliation);
 * - origin: 0x01 manual, 0x02 guardian, 0x03 ai_ticket;
 * - version: 0x01.
 * A custom 4-byte tag can replace the first four bytes (e.g. for creator attribution).
 *
 * Algo child orders (scale legs, chase re-prices, TWAP slices, trailing stops) use layout version 0x02, which keeps the
 * marker and origin and names the parent algo and the slice (see {@link algoCloid}):
 * `[0x6b 0x6f][origin][0x02][kind][parent: 6 bytes][slice: 2 bytes][attempt: 1 byte][check: 2 bytes]`.
 *
 * @module
 */
import { keccak256, stringToBytes } from "viem";
import type { IntentOrigin } from "../intents/index.js";

/** A cloid: `0x` + 32 lowercase hex characters. */
export type Cloid = `0x${string}`;

/** Two-byte marker ("ko") at the start of Kokoah cloids. */
export const KOKOAH_CLOID_MARKER = "6b6f";
/** Layout version byte. */
export const KOKOAH_CLOID_VERSION = "01";
/** Origin codes (third byte). */
export const CLOID_ORIGIN_CODES: Readonly<Record<IntentOrigin, string>> = Object.freeze({
  manual: "01",
  guardian: "02",
  ai_ticket: "03",
});

const CLOID_RE = /^0x[0-9a-f]{32}$/;

/** True for a well-formed, lowercase cloid. */
export function isCloid(value: unknown): value is Cloid {
  return typeof value === "string" && CLOID_RE.test(value);
}

function tagHex(originTag: IntentOrigin | `0x${string}` | undefined): string {
  if (originTag === undefined) return "";
  if (originTag.startsWith("0x")) {
    const hex = originTag.slice(2).toLowerCase();
    if (!/^[0-9a-f]{8}$/.test(hex)) throw new RangeError("A custom cloid tag must be 0x followed by 8 hex characters (4 bytes)");
    return hex;
  }
  const code = CLOID_ORIGIN_CODES[originTag as IntentOrigin];
  if (code === undefined) throw new RangeError(`Unknown cloid origin tag: ${originTag}`);
  return `${KOKOAH_CLOID_MARKER}${code}${KOKOAH_CLOID_VERSION}`;
}

function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generates a random cloid. With an origin (`"manual" | "guardian" | "ai_ticket"`) the first 4 bytes carry the
 * Kokoah marker, origin and version; with a `0x`-prefixed 4-byte tag they carry that tag; otherwise all 16 bytes
 * are random. Uses `crypto.getRandomValues`.
 */
export function generateCloid(originTag?: IntentOrigin | `0x${string}`): Cloid {
  const tag = tagHex(originTag);
  return `0x${tag}${randomHex(16 - tag.length / 2)}`;
}

/**
 * Deterministic cloid from a seed string (e.g. `"<ruleId>:<sequence>"`): tag + the first bytes of keccak256(seed).
 * Same seed → same cloid, which makes retries idempotent and lets pure functions (guardians) emit stable ids.
 */
export function deriveCloid(seed: string, originTag?: IntentOrigin | `0x${string}`): Cloid {
  const tag = tagHex(originTag);
  const hash = keccak256(stringToBytes(seed)).slice(2);
  return `0x${tag}${hash.slice(0, 32 - tag.length)}`;
}

/** Decoded cloid metadata. */
export interface CloidInfo {
  /** True when the cloid carries the Kokoah marker and a known layout version. */
  kokoah: boolean;
  origin?: IntentOrigin;
  /** First 4 bytes as hex (without 0x). */
  tag: string;
  /** Present on algo child orders (layout version 0x02 with a valid check). */
  algo?: AlgoCloidInfo;
}

/** Reads the Kokoah tag from a cloid. Returns null for malformed input. */
export function parseCloid(cloid: string): CloidInfo | null {
  const c = cloid.toLowerCase();
  if (!CLOID_RE.test(c)) return null;
  const tag = c.slice(2, 10);
  const version = tag.slice(6, 8);
  const algo = version === KOKOAH_ALGO_CLOID_VERSION ? decodeAlgo(c) : undefined;
  const kokoah = tag.startsWith(KOKOAH_CLOID_MARKER) && (version === KOKOAH_CLOID_VERSION || algo !== undefined);
  if (!kokoah) return { kokoah: false, tag };
  const code = tag.slice(4, 6);
  const origin = (Object.keys(CLOID_ORIGIN_CODES) as IntentOrigin[]).find((o) => CLOID_ORIGIN_CODES[o] === code);
  const info: CloidInfo = origin ? { kokoah: true, origin, tag } : { kokoah: true, tag };
  if (algo) info.algo = algo;
  return info;
}

// ---------------------------------------------------------------------------------------------
// Algo child orders
// ---------------------------------------------------------------------------------------------

/** Layout version byte of algo child cloids. */
export const KOKOAH_ALGO_CLOID_VERSION = "02";
/** Algo kinds that tag their child orders. */
export const ALGO_KINDS = ["scale", "chase", "twap", "trail"] as const;
export type AlgoKind = (typeof ALGO_KINDS)[number];
/** Kind codes (fifth byte of an algo cloid). */
export const ALGO_KIND_CODES: Readonly<Record<AlgoKind, string>> = Object.freeze({ scale: "01", chase: "02", twap: "03", trail: "04" });
/** Largest slice number an algo cloid can carry (2 bytes). */
export const MAX_ALGO_SLICE = 0xffff;
/** Largest attempt number an algo cloid can carry (1 byte). */
export const MAX_ALGO_ATTEMPT = 0xff;

/** Which algo a child order belongs to. */
export interface AlgoCloidTag {
  kind: AlgoKind;
  /** The parent algo's id (any string, e.g. a UUID or a guardian rule id). */
  parent: string;
  /** Leg, re-price or slice number, 0 to {@link MAX_ALGO_SLICE}. */
  slice: number;
  /** Retry of the same slice, 0 to {@link MAX_ALGO_ATTEMPT}. Default 0. */
  attempt?: number;
}

/** Decoded algo part of a cloid. `parentTag` is {@link algoParentTag} of the parent id. */
export interface AlgoCloidInfo {
  kind: AlgoKind;
  parentTag: string;
  slice: number;
  attempt: number;
}

/** Six-byte tag (12 hex characters) that stands for a parent algo id inside its children's cloids. */
export function algoParentTag(parent: string): string {
  return keccak256(stringToBytes(`kokoah-algo:${parent}`)).slice(2, 14);
}

function algoCheck(head: string): string {
  return keccak256(`0x${head}`).slice(2, 6);
}

/**
 * Deterministic cloid of an algo child order: the same (kind, parent, slice, attempt, origin) always gives the same
 * cloid, so a retried slice is recognised by Hyperliquid and by reconciliation, and any device can tell which algo an
 * order belongs to ("TWAP 12/120"). The last two bytes check the rest, so random cloids are not mistaken for algo ones.
 */
export function algoCloid(tag: AlgoCloidTag, origin: IntentOrigin = "manual"): Cloid {
  const attempt = tag.attempt ?? 0;
  if (!Number.isInteger(tag.slice) || tag.slice < 0 || tag.slice > MAX_ALGO_SLICE) throw new RangeError(`Algo slice must be an integer from 0 to ${MAX_ALGO_SLICE}`);
  if (!Number.isInteger(attempt) || attempt < 0 || attempt > MAX_ALGO_ATTEMPT) throw new RangeError(`Algo attempt must be an integer from 0 to ${MAX_ALGO_ATTEMPT}`);
  const kind = ALGO_KIND_CODES[tag.kind];
  if (kind === undefined) throw new RangeError(`Unknown algo kind: ${String(tag.kind)}`);
  const originCode = CLOID_ORIGIN_CODES[origin];
  if (originCode === undefined) throw new RangeError(`Unknown cloid origin tag: ${String(origin)}`);
  const head =
    `${KOKOAH_CLOID_MARKER}${originCode}${KOKOAH_ALGO_CLOID_VERSION}${kind}${algoParentTag(tag.parent)}` +
    `${tag.slice.toString(16).padStart(4, "0")}${attempt.toString(16).padStart(2, "0")}`;
  return `0x${head}${algoCheck(head)}`;
}

function decodeAlgo(c: string): AlgoCloidInfo | undefined {
  const hex = c.slice(2);
  if (!hex.startsWith(KOKOAH_CLOID_MARKER) || algoCheck(hex.slice(0, 28)) !== hex.slice(28)) return undefined;
  const code = hex.slice(8, 10);
  const kind = (Object.keys(ALGO_KIND_CODES) as AlgoKind[]).find((k) => ALGO_KIND_CODES[k] === code);
  if (!kind) return undefined;
  return { kind, parentTag: hex.slice(10, 22), slice: parseInt(hex.slice(22, 26), 16), attempt: parseInt(hex.slice(26, 28), 16) };
}

/** True when `cloid` is a child order of the algo `parent` (optionally of a given kind). */
export function isAlgoChild(cloid: string | null | undefined, parent: string, kind?: AlgoKind): boolean {
  const algo = cloid ? parseCloid(cloid)?.algo : undefined;
  return !!algo && algo.parentTag === algoParentTag(parent) && (kind === undefined || algo.kind === kind);
}
