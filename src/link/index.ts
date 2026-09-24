/**
 * Device linking ("Link phone"): the matching code that the computer and the phone both show while a phone is being
 * linked to an account.
 *
 * The computer creates a pairing and shows a QR code whose URL fragment carries a one-time token (sent to the
 * backend) and a random link secret (never sent anywhere). The phone creates its own agent key; the backend relays
 * the phone's agent address to the computer. Both sides then compute {@link deviceLinkCode} over the same fields with
 * the link secret. The user approves on the computer only when both screens show the same code, so a relay that
 * swapped in another agent address (someone who copied the QR, or a compromised relay without the secret) produces a
 * different code.
 *
 * Pure and synchronous (HMAC-SHA256 built on viem's `sha256`), so the signer frame, the app and tests share it.
 *
 * @module
 */
import { sha256 } from "viem";

/** Digits in a matching code. */
export const LINK_CODE_DIGITS = 6;
/** Bytes of entropy in a link secret (22 base64url characters). */
export const LINK_SECRET_BYTES = 16;
/** A link secret: 16 random bytes, base64url without padding. */
export const LINK_SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;
/** A pairing id: a lowercase UUID as the backend issues it. */
export const LINK_PAIRING_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Domain separation for the code's HMAC input. */
export const LINK_CODE_DOMAIN = "kokoah-device-link/v1";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const AGENT_NAME = /^[A-Za-z0-9._-]{1,16}$/;
const BLOCK = 64;

/** What both devices know when the code is shown. */
export interface DeviceLinkCodeInput {
  /** The link secret from the QR code's fragment (base64url, 16 bytes). */
  secret: string;
  /** The pairing id the backend issued. */
  pairingId: string;
  /** The account (main wallet) the phone is being linked to. */
  userAddress: string;
  /** The phone's new agent address. */
  agentAddress: string;
  /** The agent name the main wallet will approve (without the `valid_until` suffix). */
  agentName: string;
  /** The agent's expiry (ms since epoch) the main wallet will approve. */
  validUntil: number;
}

/** Decodes base64url (no padding) into bytes. Throws on any other alphabet. */
export function base64UrlToBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s) || s.length % 4 === 1) throw new RangeError("Not base64url");
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encodes bytes as base64url without padding. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A fresh link secret from a CSPRNG (`crypto.getRandomValues`). */
export function generateLinkSecret(random: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (b) => globalThis.crypto.getRandomValues(b)): string {
  return bytesToBase64Url(random(new Uint8Array(LINK_SECRET_BYTES)));
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > BLOCK ? sha256(key, "bytes") : key;
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const byte = k[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256(inner, "bytes"), BLOCK);
  return sha256(outer, "bytes");
}

/** The exact bytes the code authenticates (one field per line, addresses lowercase). */
export function deviceLinkCodeMessage(input: Omit<DeviceLinkCodeInput, "secret">): Uint8Array {
  if (!LINK_PAIRING_ID_PATTERN.test(input.pairingId)) throw new RangeError("pairingId must be a lowercase UUID");
  if (!ADDRESS.test(input.userAddress)) throw new RangeError("userAddress must be a 20-byte hex address");
  if (!ADDRESS.test(input.agentAddress)) throw new RangeError("agentAddress must be a 20-byte hex address");
  if (!AGENT_NAME.test(input.agentName) || /valid_until/.test(input.agentName)) throw new RangeError("agentName must be 1-16 of A-Z a-z 0-9 . _ -");
  if (!Number.isSafeInteger(input.validUntil) || input.validUntil <= 0) throw new RangeError("validUntil must be a positive integer (ms)");
  const text = [LINK_CODE_DOMAIN, input.pairingId, input.userAddress.toLowerCase(), input.agentAddress.toLowerCase(), input.agentName, String(input.validUntil)].join("\n");
  return new TextEncoder().encode(text);
}

/**
 * The 6-digit matching code: HMAC-SHA256 keyed with the link secret over {@link deviceLinkCodeMessage}, first 4
 * bytes as an unsigned integer, modulo 10^6, zero-padded. Any change to any field changes the code (except with
 * probability 10^-6).
 */
export function deviceLinkCode(input: DeviceLinkCodeInput): string {
  if (!LINK_SECRET_PATTERN.test(input.secret)) throw new RangeError("secret must be 16 bytes of base64url");
  const mac = hmacSha256(base64UrlToBytes(input.secret), deviceLinkCodeMessage(input));
  const n = ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0;
  return String(n % 10 ** LINK_CODE_DIGITS).padStart(LINK_CODE_DIGITS, "0");
}

/** `"482913"` → `"482 913"` (easier to compare aloud). Anything else is returned unchanged. */
export function formatLinkCode(code: string): string {
  return /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}
