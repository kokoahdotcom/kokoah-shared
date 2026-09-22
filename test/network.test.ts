import { describe, expect, it } from "vitest";
import {
  assertWriteAllowed,
  DEFAULT_NETWORK,
  getNetworkConfig,
  isWriteAllowed,
  MAINNET,
  MainnetWriteBlockedError,
  parseNetworkName,
  TESTNET,
} from "../src/network/index.js";

describe("network", () => {
  it("defaults to testnet", () => {
    expect(DEFAULT_NETWORK).toBe(TESTNET);
    expect(getNetworkConfig().name).toBe("testnet");
    expect(TESTNET.isTestnet).toBe(true);
    expect(TESTNET.signatureSource).toBe("b");
    expect(TESTNET.hyperliquidChain).toBe("Testnet");
    expect(TESTNET.infoUrl).toBe("https://api.hyperliquid-testnet.xyz/info");
    expect(TESTNET.exchangeUrl).toBe("https://api.hyperliquid-testnet.xyz/exchange");
    expect(TESTNET.wsUrl).toBe("wss://api.hyperliquid-testnet.xyz/ws");
  });

  it("describes mainnet with writes blocked", () => {
    expect(MAINNET.signatureSource).toBe("a");
    expect(MAINNET.hyperliquidChain).toBe("Mainnet");
    expect(MAINNET.infoUrl).toBe("https://api.hyperliquid.xyz/info");
    expect(MAINNET.wsUrl).toBe("wss://api.hyperliquid.xyz/ws");
    expect(MAINNET.allowMainnetWrites).toBe(false);
    expect(Object.isFrozen(MAINNET)).toBe(true);
  });

  it("parses env values safely: only an explicit 'mainnet' selects mainnet", () => {
    expect(parseNetworkName(undefined)).toBe("testnet");
    expect(parseNetworkName("")).toBe("testnet");
    expect(parseNetworkName("main")).toBe("testnet");
    expect(parseNetworkName(" MAINNET ")).toBe("mainnet");
    expect(parseNetworkName("testnet")).toBe("testnet");
  });

  it("guards mainnet writes", () => {
    expect(() => assertWriteAllowed(TESTNET)).not.toThrow();
    expect(() => assertWriteAllowed(MAINNET)).toThrow(MainnetWriteBlockedError);
    expect(() => assertWriteAllowed(getNetworkConfig("mainnet"))).toThrow(MainnetWriteBlockedError);
    expect(() => assertWriteAllowed(getNetworkConfig("mainnet", { allowMainnetWrites: false }))).toThrow(MainnetWriteBlockedError);
    expect(() => assertWriteAllowed(getNetworkConfig("mainnet", { allowMainnetWrites: true }))).not.toThrow();
    // A spoofed/inconsistent config is refused.
    expect(() => assertWriteAllowed({ name: "testnet", isTestnet: false, allowMainnetWrites: false })).toThrow(MainnetWriteBlockedError);
    expect(() => assertWriteAllowed({ name: "mainnet", isTestnet: true, allowMainnetWrites: true })).toThrow(MainnetWriteBlockedError);
    expect(isWriteAllowed(MAINNET)).toBe(false);
    expect(isWriteAllowed(TESTNET)).toBe(true);
    try {
      assertWriteAllowed(MAINNET);
    } catch (e) {
      expect((e as MainnetWriteBlockedError).code).toBe("MAINNET_WRITE_BLOCKED");
    }
  });

  it("ignores allowMainnetWrites on testnet and supports URL overrides", () => {
    expect(getNetworkConfig("testnet", { allowMainnetWrites: true }).allowMainnetWrites).toBe(false);
    const c = getNetworkConfig("mainnet", { apiUrl: "https://example.org/hl/", wsUrl: "wss://example.org/ws" });
    expect(c.infoUrl).toBe("https://example.org/hl/info");
    expect(c.exchangeUrl).toBe("https://example.org/hl/exchange");
    expect(c.wsUrl).toBe("wss://example.org/ws");
    expect(c.defaultSignatureChainId).toBe("0xa4b1");
  });
});
