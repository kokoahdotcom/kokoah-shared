import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  deviceLinkCode,
  deviceLinkCodeMessage,
  formatLinkCode,
  generateLinkSecret,
  hmacSha256,
  LINK_SECRET_PATTERN,
} from "../src/link/index.js";

const input = {
  secret: "AAECAwQFBgcICQoLDA0ODw",
  pairingId: "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f",
  userAddress: "0x1111111111111111111111111111111111111111",
  agentAddress: "0x2222222222222222222222222222222222222222",
  agentName: "kokoah-ab12",
  validUntil: 1_790_000_000_000,
};

describe("hmacSha256", () => {
  it("matches node:crypto for short, block-sized and long keys", () => {
    for (const keyLength of [0, 16, 64, 65, 200]) {
      const key = randomBytes(keyLength);
      const message = randomBytes(keyLength * 3 + 1);
      const expected = createHmac("sha256", key).update(message).digest();
      expect(Buffer.from(hmacSha256(key, message)).equals(expected)).toBe(true);
    }
  });
});

describe("base64url", () => {
  it("round-trips bytes", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = new Uint8Array(randomBytes(n));
      expect(base64UrlToBytes(bytesToBase64Url(bytes))).toEqual(bytes);
      expect(bytesToBase64Url(bytes)).toBe(Buffer.from(bytes).toString("base64url"));
    }
  });
  it("rejects other alphabets", () => {
    expect(() => base64UrlToBytes("ab+/")).toThrow(RangeError);
    expect(() => base64UrlToBytes("a")).toThrow(RangeError);
  });
});

describe("deviceLinkCode", () => {
  it("is a fixed 6-digit code for fixed input (golden: the frame and the app must agree)", () => {
    const expected = String(createHmac("sha256", Buffer.from(input.secret, "base64url")).update(deviceLinkCodeMessage(input)).digest().readUInt32BE(0) % 1_000_000).padStart(6, "0");
    expect(deviceLinkCode(input)).toBe(expected);
    expect(deviceLinkCode(input)).toMatch(/^\d{6}$/);
    expect(new TextDecoder().decode(deviceLinkCodeMessage(input))).toBe(
      "kokoah-device-link/v1\n0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e5f\n0x1111111111111111111111111111111111111111\n0x2222222222222222222222222222222222222222\nkokoah-ab12\n1790000000000",
    );
  });

  it("ignores address case", () => {
    expect(deviceLinkCode({ ...input, agentAddress: "0x2222222222222222222222222222222222222222".toUpperCase().replace("0X", "0x") })).toBe(deviceLinkCode(input));
  });

  it("changes when any field changes", () => {
    const base = deviceLinkCode(input);
    const variants = [
      { secret: "AAECAwQFBgcICQoLDA0OEA" },
      { pairingId: "0b7f1a52-3c3d-4c1e-9d0e-6a1b2c3d4e60" },
      { userAddress: "0x1111111111111111111111111111111111111112" },
      { agentAddress: "0x2222222222222222222222222222222222222223" },
      { agentName: "kokoah-ab13" },
      { validUntil: input.validUntil + 1 },
    ];
    for (const v of variants) expect(deviceLinkCode({ ...input, ...v })).not.toBe(base);
  });

  it("validates every field", () => {
    expect(() => deviceLinkCode({ ...input, secret: "short" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, pairingId: "not-a-uuid" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, pairingId: input.pairingId.toUpperCase() })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, userAddress: "0x12" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, agentAddress: "nope" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, agentName: "kokoah valid_until 1" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, agentName: "a-name-that-is-too-long" })).toThrow(RangeError);
    expect(() => deviceLinkCode({ ...input, validUntil: 1.5 })).toThrow(RangeError);
  });

  it("spreads codes over the range", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) seen.add(deviceLinkCode({ ...input, validUntil: input.validUntil + i }));
    expect(seen.size).toBeGreaterThan(195);
  });
});

describe("helpers", () => {
  it("generates 16-byte secrets", () => {
    const a = generateLinkSecret();
    expect(a).toMatch(LINK_SECRET_PATTERN);
    expect(base64UrlToBytes(a)).toHaveLength(16);
    expect(generateLinkSecret()).not.toBe(a);
    expect(generateLinkSecret((b) => b.fill(0))).toBe("AAAAAAAAAAAAAAAAAAAAAA");
  });
  it("formats codes in two groups", () => {
    expect(formatLinkCode("482913")).toBe("482 913");
    expect(formatLinkCode("12")).toBe("12");
  });
});
