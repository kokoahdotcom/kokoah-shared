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
 * Pure, synchronous and dependency-free (its own SHA-256 and HMAC, checked against node:crypto), so the signer frame,
 * the app and tests share it without pulling hashing code into anyone's initial bundle.
 *
 * @module
 */

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

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

/** SHA-256 (FIPS 180-4) of `data`. */
export function sha256Bytes(data: Uint8Array): Uint8Array {
  const bitLength = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 2 ** 32));
  view.setUint32(padded.length - 4, bitLength >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15]!;
      const b = w[i - 2]!;
      w[i] = (w[i - 16]! + (rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3)) + w[i - 7]! + (rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10))) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0]!, h[1]!, h[2]!, h[3]!, h[4]!, h[5]!, h[6]!, h[7]!];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      [hh, g, f, e, d, c, b, a] = [g, f, e, (d + t1) >>> 0, c, b, a, (t1 + t2) >>> 0];
    }
    const next = [a, b, c, d, e, f, g, hh];
    for (let i = 0; i < 8; i++) h[i] = (h[i]! + next[i]!) >>> 0;
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) outView.setUint32(i * 4, h[i]!);
  return out;
}

/** HMAC-SHA256 (RFC 2104). */
export function hmacSha256(key: Uint8Array, message: Uint8Array): Uint8Array {
  const k = key.length > BLOCK ? sha256Bytes(key) : key;
  const inner = new Uint8Array(BLOCK + message.length);
  const outer = new Uint8Array(BLOCK + 32);
  for (let i = 0; i < BLOCK; i++) {
    const byte = k[i] ?? 0;
    inner[i] = byte ^ 0x36;
    outer[i] = byte ^ 0x5c;
  }
  inner.set(message, BLOCK);
  outer.set(sha256Bytes(inner), BLOCK);
  return sha256Bytes(outer);
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
