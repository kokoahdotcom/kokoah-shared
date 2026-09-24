import { generatePrivateKey, privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { MainnetWriteBlockedError, getNetworkConfig, MAINNET, TESTNET } from "../src/network/index.js";
import {
  buildApproveAgent,
  buildAccountMode,
  buildApproveBuilderFee,
  buildExchangeRequest,
  buildRevokeAgent,
  buildSendAsset,
  buildSubAccountTransfer,
  buildWithdraw,
  expiresAfterFromNow,
  formatAgentName,
  hashL1Action,
  isNonceInWindow,
  l1SigningDigest,
  l1TypedData,
  MAX_AGENT_VALIDITY_MS,
  MonotonicNonceManager,
  parseAgentName,
  prepareL1Request,
  recoverL1Signer,
  recoverUserSignedSigner,
  signatureFromHex,
  signatureToHex,
  signL1Action,
  userSignedDigest,
} from "../src/signing/index.js";

const NOW = 1_790_000_000_000;
const DAY = 86_400_000;

describe("approveAgent typed data (main wallet signs in the browser)", () => {
  const agent = privateKeyToAccount(generatePrivateKey());

  it("builds a named agent with valid_until and matching action/typed data", async () => {
    const p = buildApproveAgent({ agentAddress: agent.address, agentName: "kokoah-web", validUntil: NOW + 30 * DAY, nonce: NOW, network: MAINNET });
    expect(p.action).toEqual({
      type: "approveAgent",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      agentAddress: agent.address.toLowerCase(),
      agentName: `kokoah-web valid_until ${NOW + 30 * DAY}`,
      nonce: NOW,
    });
    expect(Object.keys(p.action)).toEqual(["type", "signatureChainId", "hyperliquidChain", "agentAddress", "agentName", "nonce"]);
    expect(p.typedData.domain).toEqual({ name: "HyperliquidSignTransaction", version: "1", chainId: 42161, verifyingContract: "0x0000000000000000000000000000000000000000" });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:ApproveAgent");
    expect(p.typedData.types["HyperliquidTransaction:ApproveAgent"]!.map((f) => f.name)).toEqual(["hyperliquidChain", "agentAddress", "agentName", "nonce"]);
    expect(p.typedData.message).toEqual({ hyperliquidChain: "Mainnet", agentAddress: agent.address.toLowerCase(), agentName: `kokoah-web valid_until ${NOW + 30 * DAY}`, nonce: NOW });
    expect(p.nonce).toBe(NOW);
    // A main wallet signs it; the signer is recoverable.
    const main = privateKeyToAccount(generatePrivateKey());
    const sig = signatureFromHex(await main.signTypedData(p.typedData as Parameters<typeof main.signTypedData>[0]));
    expect((await recoverUserSignedSigner({ typedData: p.typedData, signature: sig })).toLowerCase()).toBe(main.address.toLowerCase());
    expect(userSignedDigest(p.typedData)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("uses the testnet chain and a caller-provided signatureChainId", () => {
    const p = buildApproveAgent({ agentAddress: agent.address, agentName: "kokoah-pwa", validUntil: NOW + DAY, nonce: NOW, network: TESTNET, signatureChainId: "0x1" });
    expect(p.action).toMatchObject({ hyperliquidChain: "Testnet", signatureChainId: "0x1" });
    expect(p.typedData.domain.chainId).toBe(1);
  });

  it("enforces the 180-day cap, a future expiry and the 16-character name limit", () => {
    const base = { agentAddress: agent.address, nonce: NOW, network: TESTNET } as const;
    expect(() => buildApproveAgent({ ...base, agentName: "kokoah-web", validUntil: NOW + MAX_AGENT_VALIDITY_MS })).not.toThrow();
    expect(() => buildApproveAgent({ ...base, agentName: "kokoah-web", validUntil: NOW + MAX_AGENT_VALIDITY_MS + 1 })).toThrow(RangeError);
    expect(() => buildApproveAgent({ ...base, agentName: "kokoah-web", validUntil: NOW })).toThrow(RangeError);
    expect(() => buildApproveAgent({ ...base, agentName: "x".repeat(17), validUntil: NOW + DAY })).toThrow(RangeError);
    expect(() => buildApproveAgent({ ...base, agentName: "", validUntil: NOW + DAY })).toThrow(RangeError);
    expect(() => buildApproveAgent({ ...base, agentName: "a valid_until 1", validUntil: NOW + DAY })).toThrow(RangeError);
    expect(() => buildApproveAgent({ ...base, agentAddress: "0x12", agentName: "k", validUntil: NOW + DAY })).toThrow(RangeError);
  });

  it("formats and parses agent names", () => {
    expect(formatAgentName("kokoah-web", 123)).toBe("kokoah-web valid_until 123");
    expect(formatAgentName("kokoah-web")).toBe("kokoah-web");
    expect(parseAgentName("kokoah-web valid_until 123")).toEqual({ name: "kokoah-web", validUntil: 123 });
    expect(parseAgentName("Mobile QR")).toEqual({ name: "Mobile QR" });
  });

  it("builds a revoke (same name, zero address)", () => {
    const p = buildRevokeAgent({ agentName: "kokoah-web", nonce: NOW, network: TESTNET });
    expect(p.action).toMatchObject({ agentAddress: "0x0000000000000000000000000000000000000000", agentName: "kokoah-web" });
  });
});

describe("approveBuilderFee and withdraw typed data", () => {
  const builder = "0x1111111111111111111111111111111111111111" as const;
  it("formats maxFeeRate from tenths of a bp and caps it at 0.1%", () => {
    const p = buildApproveBuilderFee({ builder, maxFeeTenthsBps: 100, nonce: NOW, network: MAINNET });
    expect(p.action).toEqual({ type: "approveBuilderFee", signatureChainId: "0xa4b1", hyperliquidChain: "Mainnet", maxFeeRate: "0.1%", builder, nonce: NOW });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:ApproveBuilderFee");
    expect(buildApproveBuilderFee({ builder, maxFeeTenthsBps: 25, nonce: NOW, network: TESTNET }).action.maxFeeRate).toBe("0.025%");
    expect(buildApproveBuilderFee({ builder, maxFeeTenthsBps: 0, nonce: NOW, network: TESTNET }).action.maxFeeRate).toBe("0%");
    expect(() => buildApproveBuilderFee({ builder, maxFeeTenthsBps: 101, nonce: NOW, network: TESTNET })).toThrow(RangeError);
    expect(() => buildApproveBuilderFee({ builder, maxFeeTenthsBps: 2.5, nonce: NOW, network: TESTNET })).toThrow(RangeError);
  });
  it("withdraw3 uses time = nonce and a normalized amount", () => {
    const p = buildWithdraw({ destination: builder, amount: "12.50", nonce: NOW, network: TESTNET });
    expect(p.action).toMatchObject({ type: "withdraw3", amount: "12.5", time: NOW, hyperliquidChain: "Testnet" });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:Withdraw");
  });
});

describe("sendAsset typed data", () => {
  const destination = "0x3333333333333333333333333333333333333333" as const;
  const token = "USDC:0x6d1e7cde53ba9467b783cb7c530ce054";
  const base = { destination, sourceDex: "", destinationDex: "", token, amount: "25.50", nonce: NOW, network: MAINNET };
  it("signs every field as a readable string and posts the same action", () => {
    const p = buildSendAsset(base);
    expect(p.action).toEqual({
      type: "sendAsset",
      signatureChainId: "0xa4b1",
      hyperliquidChain: "Mainnet",
      destination,
      sourceDex: "",
      destinationDex: "",
      token,
      amount: "25.5",
      fromSubAccount: "",
      nonce: NOW,
    });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:SendAsset");
    expect(p.typedData.domain.name).toBe("HyperliquidSignTransaction");
    expect(p.typedData.types["HyperliquidTransaction:SendAsset"]?.map((f) => f.type)).toEqual([
      "string",
      "string",
      "string",
      "string",
      "string",
      "string",
      "string",
      "uint64",
    ]);
    expect(p.typedData.message).toMatchObject({ destination, token, amount: "25.5", fromSubAccount: "", nonce: NOW });
  });
  it("lowercases the destination and the token id, and keeps spot as spot", () => {
    const p = buildSendAsset({
      ...base,
      destination: "0xABCDEF0000000000000000000000000000000001",
      sourceDex: "spot",
      destinationDex: "spot",
      token: "USDC:0x6D1E7CDE53BA9467B783CB7C530CE054",
      network: TESTNET,
    });
    expect(p.action).toMatchObject({
      destination: "0xabcdef0000000000000000000000000000000001",
      sourceDex: "spot",
      destinationDex: "spot",
      token,
      hyperliquidChain: "Testnet",
    });
    expect(p.typedData.message.destination).toBe(p.action.destination);
  });
  it("refuses bad destinations, dexes, tokens and amounts", () => {
    expect(() => buildSendAsset({ ...base, destination: "0x1234" as `0x${string}` })).toThrow(RangeError);
    expect(() => buildSendAsset({ ...base, destination: "0x0000000000000000000000000000000000000000" })).toThrow(/zero address/);
    expect(() => buildSendAsset({ ...base, sourceDex: "Spot " })).toThrow(RangeError);
    expect(() => buildSendAsset({ ...base, destinationDex: "a:b" })).toThrow(RangeError);
    expect(() => buildSendAsset({ ...base, token: "USDC" })).toThrow(/name:tokenId/);
    expect(() => buildSendAsset({ ...base, token: "USDC:0x1234" })).toThrow(RangeError);
    expect(() => buildSendAsset({ ...base, amount: "0" })).toThrow(/above zero/);
    expect(() => buildSendAsset({ ...base, amount: "-1" })).toThrow(/above zero/);
    expect(() => buildSendAsset({ ...base, amount: "abc" })).toThrow();
  });
  it("recovers the main wallet from its signature", async () => {
    const wallet = privateKeyToAccount(generatePrivateKey());
    const p = buildSendAsset(base);
    const hex = await wallet.signTypedData(p.typedData as Parameters<typeof wallet.signTypedData>[0]);
    expect(await recoverUserSignedSigner({ typedData: p.typedData, signature: signatureFromHex(hex) })).toBe(wallet.address);
  });
  it("signs a send from a sub-account as a readable fromSubAccount", () => {
    const sub = "0xAAAA000000000000000000000000000000000001" as const;
    const p = buildSendAsset({ ...base, fromSubAccount: sub });
    expect(p.action.fromSubAccount).toBe(sub.toLowerCase());
    expect(p.typedData.message.fromSubAccount).toBe(sub.toLowerCase());
    expect(() => buildSendAsset({ ...base, fromSubAccount: "0x12" as `0x${string}` })).toThrow(/fromSubAccount/);
    expect(() => buildSendAsset({ ...base, fromSubAccount: "0x0000000000000000000000000000000000000000" })).toThrow(/zero address/);
    expect(() => buildSendAsset({ ...base, fromSubAccount: destination })).toThrow(/differ/);
  });
});

describe("moving funds between the main account and a sub-account", () => {
  const master = "0x1111000000000000000000000000000000000001" as const;
  const subAccount = "0x2222000000000000000000000000000000000002" as const;
  const base = { master, subAccount, token: "USDC:0xeb62eee3685fc4c43992febcd9e75443", amount: "10", nonce: NOW, network: TESTNET };
  it("sends to the sub-account from the main account", () => {
    const p = buildSubAccountTransfer({ ...base, direction: "toSubAccount" });
    expect(p.action).toMatchObject({ type: "sendAsset", destination: subAccount, fromSubAccount: "", sourceDex: "", destinationDex: "", amount: "10" });
  });
  it("sends back to the main account from the sub-account", () => {
    const p = buildSubAccountTransfer({ ...base, direction: "toMaster", dex: "spot" });
    expect(p.action).toMatchObject({ destination: master, fromSubAccount: subAccount, sourceDex: "spot", destinationDex: "spot" });
    expect(p.typedData.message).toMatchObject({ destination: master, fromSubAccount: subAccount });
  });
  it("refuses a sub-account equal to the master and bad input", () => {
    expect(() => buildSubAccountTransfer({ ...base, subAccount: master, direction: "toMaster" })).toThrow(/differ/);
    expect(() => buildSubAccountTransfer({ ...base, master: "0x1" as `0x${string}`, direction: "toMaster" })).toThrow(/master/);
    expect(() => buildSubAccountTransfer({ ...base, direction: "sideways" as "toMaster" })).toThrow(/direction/);
    expect(() => buildSubAccountTransfer({ ...base, amount: "0", direction: "toSubAccount" })).toThrow(/above zero/);
  });
});

describe("account type (userSetAbstraction) typed data", () => {
  const user = "0xABCDEF0000000000000000000000000000000001" as const;
  it("builds Standard and Unified with a lowercased user", () => {
    const p = buildAccountMode({ user, abstraction: "unifiedAccount", nonce: NOW, network: TESTNET, signatureChainId: "0x66eee" });
    expect(p.action).toEqual({
      type: "userSetAbstraction",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      user: user.toLowerCase(),
      abstraction: "unifiedAccount",
      nonce: NOW,
    });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:UserSetAbstraction");
    expect(buildAccountMode({ user, abstraction: "disabled", nonce: NOW, network: MAINNET }).action.abstraction).toBe("disabled");
  });
  it("refuses portfolio margin and other modes", () => {
    expect(() => buildAccountMode({ user, abstraction: "portfolioMargin" as "disabled", nonce: NOW, network: TESTNET })).toThrow(RangeError);
    expect(() => buildAccountMode({ user: "0x12" as `0x${string}`, abstraction: "disabled", nonce: NOW, network: TESTNET })).toThrow(RangeError);
  });
});

describe("L1 signing helpers", () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const action = { type: "cancel", cancels: [{ a: 0, o: 1 }] };

  it("the digest path (KMS-style raw signing) equals the SDK signature", async () => {
    const params = { action, nonce: NOW, network: TESTNET, expiresAfter: NOW + 15_000 };
    const viaSdk = await signL1Action({ ...params, wallet });
    const pk = generatePrivateKey();
    const acct = privateKeyToAccount(pk);
    const s1 = await signL1Action({ ...params, wallet: acct });
    const s2 = await sign({ hash: l1SigningDigest(params), privateKey: pk });
    expect(BigInt(s1.r)).toBe(BigInt(s2.r));
    expect(BigInt(s1.s)).toBe(BigInt(s2.s));
    expect(s1.v).toBe(Number(s2.v));
    expect((await recoverL1Signer({ ...params, signature: viaSdk })).toLowerCase()).toBe(wallet.address.toLowerCase());
    expect(l1TypedData(params).message.source).toBe("b");
    expect(l1TypedData({ ...params, network: MAINNET }).message.source).toBe("a");
  });

  it("vault address and expiresAfter change the hash; vault case does not", () => {
    const h0 = hashL1Action({ action, nonce: NOW });
    const h1 = hashL1Action({ action, nonce: NOW, vaultAddress: "0x2222222222222222222222222222222222222222" });
    const h2 = hashL1Action({ action, nonce: NOW, vaultAddress: "0x2222222222222222222222222222222222222222", expiresAfter: NOW + 1 });
    expect(new Set([h0, h1, h2]).size).toBe(3);
    expect(hashL1Action({ action, nonce: NOW, vaultAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).toBe(
      hashL1Action({ action, nonce: NOW, vaultAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
    );
    // Key order matters for msgpack.
    expect(hashL1Action({ action: { cancels: [{ a: 0, o: 1 }], type: "cancel" }, nonce: NOW })).not.toBe(h0);
  });

  it("round-trips hex signatures", () => {
    const sig = { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 28 } as const;
    const hex = signatureToHex(sig);
    expect(hex).toHaveLength(132);
    expect(signatureFromHex(hex)).toEqual(sig);
    expect(signatureFromHex(`0x${"1".repeat(64)}${"2".repeat(64)}00`).v).toBe(27);
    expect(() => signatureFromHex("0x12")).toThrow(RangeError);
    expect(() => signatureFromHex(`0x${"1".repeat(128)}05`)).toThrow(RangeError);
  });
});

describe("nonces", () => {
  it("issues max(now, last + 1) per key", () => {
    let t = 1000;
    const m = new MonotonicNonceManager({ now: () => t });
    expect(m.next()).toBe(1000);
    expect(m.next()).toBe(1001); // same millisecond
    expect(m.next()).toBe(1002);
    t = 999; // clock goes backwards
    expect(m.next()).toBe(1003);
    t = 5000;
    expect(m.next()).toBe(5000);
    expect(m.next("0xAgent")).toBe(5000); // separate key
    expect(m.next("0xagent")).toBe(5001); // keys are case-insensitive
    m.observe(9000, "0xagent");
    expect(m.next("0xAGENT")).toBe(9001);
    m.observe(10, "0xagent"); // never goes down
    expect(m.peek("0xagent")).toBe(9001);
    expect(() => m.observe(5000 + 86_400_000)).toThrow(RangeError); // beyond HL's window: would stall signing
    m.setClockOffset(10_000);
    expect(m.next("fresh")).toBe(15_000);
    expect(() => m.observe(-1)).toThrow(RangeError);
  });

  it("is strictly increasing under a burst", () => {
    const m = new MonotonicNonceManager({ now: () => 42 });
    const seen = Array.from({ length: 1000 }, () => m.next());
    for (let i = 1; i < seen.length; i++) expect(seen[i]!).toBe(seen[i - 1]! + 1);
  });

  it("checks HL's accepted window", () => {
    expect(isNonceInWindow(NOW, NOW)).toBe(true);
    expect(isNonceInWindow(NOW - 2 * DAY - 1, NOW)).toBe(false);
    expect(isNonceInWindow(NOW + DAY + 1, NOW)).toBe(false);
  });
});

describe("/exchange request assembly and the mainnet guard", () => {
  const wallet = privateKeyToAccount(generatePrivateKey());
  const sig = { r: `0x${"1".repeat(64)}`, s: `0x${"2".repeat(64)}`, v: 27 } as const;

  it("refuses mainnet unless explicitly allowed", async () => {
    expect(() => buildExchangeRequest({ network: MAINNET, action: { type: "noop" }, nonce: NOW, signature: sig })).toThrow(MainnetWriteBlockedError);
    await expect(prepareL1Request({ wallet, network: MAINNET, compiled: { action: { type: "noop" } }, nonce: NOW })).rejects.toThrow(MainnetWriteBlockedError);
    const allowed = getNetworkConfig("mainnet", { allowMainnetWrites: true });
    expect(buildExchangeRequest({ network: allowed, action: { type: "noop" }, nonce: NOW, signature: sig })).toEqual({ action: { type: "noop" }, nonce: NOW, signature: sig });
  });

  it("builds a testnet body with vault and expiresAfter", async () => {
    const vault = "0x2222222222222222222222222222222222222222" as const;
    const body = await prepareL1Request({ wallet, network: TESTNET, compiled: { action: { type: "noop" }, vaultAddress: vault }, nonce: NOW, expiresAfter: NOW + 10_000 });
    expect(body).toMatchObject({ action: { type: "noop" }, nonce: NOW, vaultAddress: vault, expiresAfter: NOW + 10_000 });
    const signer = await recoverL1Signer({ action: body.action, nonce: NOW, vaultAddress: vault, expiresAfter: NOW + 10_000, network: TESTNET, signature: body.signature });
    expect(signer.toLowerCase()).toBe(wallet.address.toLowerCase());
  });

  it("refuses a user-signed action for a different chain than the network", () => {
    const mainnetAction = { type: "withdraw3", signatureChainId: "0x66eee", hyperliquidChain: "Mainnet", destination: "0x1", amount: "1", time: NOW };
    expect(() => buildExchangeRequest({ network: TESTNET, action: mainnetAction, nonce: NOW, signature: sig })).toThrow(RangeError);
    expect(() => buildExchangeRequest({ network: TESTNET, action: { ...mainnetAction, hyperliquidChain: "Testnet" }, nonce: NOW, signature: sig })).not.toThrow();
  });

  it("rejects expiresAfter and vaultAddress on user-signed actions", () => {
    const action = { type: "approveAgent", signatureChainId: "0x66eee" };
    expect(() => buildExchangeRequest({ network: TESTNET, action, nonce: NOW, signature: sig, expiresAfter: NOW })).toThrow(RangeError);
    expect(() => buildExchangeRequest({ network: TESTNET, action, nonce: NOW, signature: sig, vaultAddress: "0x2222222222222222222222222222222222222222" })).toThrow(RangeError);
    expect(buildExchangeRequest({ network: TESTNET, action, nonce: NOW, signature: sig })).toEqual({ action, nonce: NOW, signature: sig });
  });

  it("expiresAfterFromNow", () => {
    expect(expiresAfterFromNow(NOW)).toBe(NOW + 15_000);
    expect(expiresAfterFromNow(NOW, 30_000)).toBe(NOW + 30_000);
  });
});
