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
  /** True when the cloid carries the Kokoah marker and version. */
  kokoah: boolean;
  origin?: IntentOrigin;
  /** First 4 bytes as hex (without 0x). */
  tag: string;
}

/** Reads the Kokoah tag from a cloid. Returns null for malformed input. */
export function parseCloid(cloid: string): CloidInfo | null {
  const c = cloid.toLowerCase();
  if (!CLOID_RE.test(c)) return null;
  const tag = c.slice(2, 10);
  const kokoah = tag.startsWith(KOKOAH_CLOID_MARKER) && tag.slice(6, 8) === KOKOAH_CLOID_VERSION;
  if (!kokoah) return { kokoah: false, tag };
  const code = tag.slice(4, 6);
  const origin = (Object.keys(CLOID_ORIGIN_CODES) as IntentOrigin[]).find((o) => CLOID_ORIGIN_CODES[o] === code);
  return origin ? { kokoah: true, origin, tag } : { kokoah: true, tag };
}
