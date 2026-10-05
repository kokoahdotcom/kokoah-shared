import { describe, expect, it } from "vitest";
import { compileAccountAction, CompileError, safeParseAccountIntent } from "../src/actions/index.js";
import { buildStakingDeposit, buildTokenDelegate, hypeToWei } from "../src/signing/index.js";
import { getNetworkConfig } from "../src/network/index.js";
import {
  HLP_DEPOSIT_LIMITS,
  HLP_VAULT_ADDRESSES,
  isHlpVault,
  usdToVaultUnits,
  vaultDepositsSince,
  vaultTransferProblems,
  vaultUnitsToUsd,
} from "../src/vaults/index.js";

const HLP = HLP_VAULT_ADDRESSES.testnet;
const OTHER = "0x2222222222222222222222222222222222222222";
const deposit = (usd: number, vaultAddress: string = HLP) => ({ type: "vaultTransfer", vaultAddress, isDeposit: true, usd: usd * 1e6 });
const withdraw = (usd: number, vaultAddress: string = OTHER) => ({ type: "vaultTransfer", vaultAddress, isDeposit: false, usd: usd * 1e6 });
const codes = (p: ReturnType<typeof vaultTransferProblems>) => p.map((x) => x.code);

describe("vault amounts are converted exactly", () => {
  it("USDC to vault units (× 10^6) and back", () => {
    expect(usdToVaultUnits("12.5")).toBe(12_500_000);
    expect(usdToVaultUnits("0.000001")).toBe(1);
    expect(usdToVaultUnits(250)).toBe(250_000_000);
    expect(usdToVaultUnits("10000.00")).toBe(10_000_000_000);
    expect(vaultUnitsToUsd(12_500_000)).toBe("12.5");
    expect(vaultUnitsToUsd(1)).toBe("0.000001");
    expect(vaultUnitsToUsd(250_000_000)).toBe("250");
  });

  it("refuses zero, negatives, too many decimals, junk and overflow", () => {
    for (const bad of ["0", "-1", "0.0000001", "abc", "", "1e30", Number.NaN]) expect(() => usdToVaultUnits(bad)).toThrow(RangeError);
  });

  it("HYPE to staking wei (× 10^8)", () => {
    expect(hypeToWei("1.5")).toBe(150_000_000);
    expect(hypeToWei("0.00000001")).toBe(1);
    expect(() => hypeToWei("0.000000001")).toThrow(RangeError);
    expect(() => hypeToWei("0")).toThrow(RangeError);
  });
});

describe("HLP deposits by a trading key", () => {
  it("allows a deposit into HLP within the caps", () => {
    expect(vaultTransferProblems({ network: "testnet", action: deposit(250), hlpDepositedLast24hUsd: 0 })).toEqual([]);
    expect(isHlpVault("mainnet", HLP_VAULT_ADDRESSES.mainnet.toUpperCase().replace("0X", "0x"))).toBe(true);
  });

  it("refuses any vault other than HLP, and HLP of the other network", () => {
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(250, OTHER), hlpDepositedLast24hUsd: 0 }))).toEqual(["VAULT_NOT_ALLOWED"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(250, HLP_VAULT_ADDRESSES.mainnet), hlpDepositedLast24hUsd: 0 }))).toEqual(["VAULT_NOT_ALLOWED"]);
  });

  it("caps one deposit, the last 24 hours and the minimum", () => {
    const one = HLP_DEPOSIT_LIMITS.perDepositUsd;
    expect(vaultTransferProblems({ network: "testnet", action: deposit(one), hlpDepositedLast24hUsd: 0 })).toEqual([]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(one + 1), hlpDepositedLast24hUsd: 0 }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    const day = HLP_DEPOSIT_LIMITS.dailyUsd;
    expect(vaultTransferProblems({ network: "testnet", action: deposit(5000), hlpDepositedLast24hUsd: day - 5000 })).toEqual([]);
    const over = vaultTransferProblems({ network: "testnet", action: deposit(5000), hlpDepositedLast24hUsd: day - 4999.5 });
    expect(codes(over)).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    expect(over[0]?.message).toContain("4,999.5 USDC is left");
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(4), hlpDepositedLast24hUsd: 0 }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
  });

  it("refuses a deposit when today's deposits are unknown", () => {
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(10) }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: deposit(10), hlpDepositedLast24hUsd: Number.NaN }))).toEqual(["VAULT_DEPOSIT_LIMIT"]);
  });

  it("refuses malformed actions before any rule", () => {
    expect(codes(vaultTransferProblems({ network: "testnet", action: { ...deposit(10), extra: 1 } as never, hlpDepositedLast24hUsd: 0 }))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: { ...deposit(10), vaultAddress: HLP.toUpperCase() }, hlpDepositedLast24hUsd: 0 }))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: { ...deposit(10), usd: 1.5 }, hlpDepositedLast24hUsd: 0 }))).toEqual(["INVALID_SUBJECT"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: { type: "order" }, hlpDepositedLast24hUsd: 0 }))).toEqual(["INVALID_SUBJECT"]);
  });
});

describe("vault withdrawals by a trading key", () => {
  it("allows a withdrawal from any vault the account holds, up to its equity", () => {
    expect(vaultTransferProblems({ network: "testnet", action: withdraw(100), heldEquityUsd: 100 })).toEqual([]);
    expect(vaultTransferProblems({ network: "testnet", action: withdraw(50, HLP), heldEquityUsd: 80 })).toEqual([]);
  });

  it("refuses a vault the account doesn't hold, or more than its equity", () => {
    expect(codes(vaultTransferProblems({ network: "testnet", action: withdraw(10) }))).toEqual(["VAULT_NOT_ALLOWED"]);
    expect(codes(vaultTransferProblems({ network: "testnet", action: withdraw(101), heldEquityUsd: 100 }))).toEqual(["VAULT_NOT_ALLOWED"]);
  });
});

describe("today's HLP deposits from Hyperliquid's ledger", () => {
  const now = 1_790_000_000_000;
  const ledger = [
    { time: now - 1000, delta: { type: "vaultDeposit", vault: HLP.toUpperCase().replace("0X", "0x"), usdc: "100.5" } },
    { time: now - 2000, delta: { type: "vaultDeposit", vault: OTHER, usdc: "999" } },
    { time: now - 30 * 3_600_000, delta: { type: "vaultDeposit", vault: HLP, usdc: "5000" } },
    { time: now - 3000, delta: { type: "deposit", usdc: "77" } },
    { time: now - 4000, delta: { type: "vaultWithdraw", vault: HLP, requestedUsd: "10" } },
  ];
  it("sums HLP deposits in the window only", () => {
    expect(vaultDepositsSince(ledger, HLP, now - 24 * 3_600_000)).toBe(100.5);
  });
  it("throws on an unreadable vault deposit instead of under-counting", () => {
    expect(() => vaultDepositsSince([{ time: now, delta: { type: "vaultDeposit", vault: HLP } }], HLP, 0)).toThrow(RangeError);
    expect(() => vaultDepositsSince({}, HLP, 0)).toThrow(RangeError);
  });
});

describe("HLP deposit and vault withdrawal intents", () => {
  it("an HLP deposit names only an amount; the vault is the signer's own", () => {
    expect(safeParseAccountIntent({ kind: "hlpDeposit", origin: "manual", usd: "250", vaultAddress: OTHER }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "hlpDeposit", origin: "bot", usd: "250" }).success).toBe(false);
    expect(safeParseAccountIntent({ kind: "hlpDeposit", origin: "manual", usd: "1.1234567" }).success).toBe(false);
    const c = compileAccountAction({ kind: "hlpDeposit", origin: "manual", usd: "250" }, { hlpVaultAddress: HLP });
    expect(c.action).toEqual({ type: "vaultTransfer", vaultAddress: HLP, isDeposit: true, usd: 250_000_000 });
    expect(() => compileAccountAction({ kind: "hlpDeposit", origin: "manual", usd: "250" })).toThrow(CompileError);
  });

  it("a vault withdrawal names its vault, lowercased", () => {
    const c = compileAccountAction({ kind: "vaultWithdraw", origin: "manual", vaultAddress: OTHER.replace(/2/g, "A"), usd: "12.5" });
    expect(c.action).toEqual({ type: "vaultTransfer", vaultAddress: OTHER.replace(/2/g, "a"), isDeposit: false, usd: 12_500_000 });
  });
});

describe("staking builders", () => {
  const network = getNetworkConfig("testnet");
  it("cDeposit signs the network, the amount in wei and the nonce", () => {
    const p = buildStakingDeposit({ amount: "10", nonce: 1, network });
    expect(p.typedData.primaryType).toBe("HyperliquidTransaction:CDeposit");
    expect(p.typedData.message).toEqual({ hyperliquidChain: "Testnet", wei: 1_000_000_000, nonce: 1 });
  });
  it("tokenDelegate lowercases the validator and refuses the zero address", () => {
    const p = buildTokenDelegate({ validator: OTHER.replace(/2/g, "B") as `0x${string}`, amount: "1", undelegate: false, nonce: 1, network });
    expect(p.typedData.message.validator).toBe(OTHER.replace(/2/g, "b"));
    expect(() => buildTokenDelegate({ validator: "0x0000000000000000000000000000000000000000", amount: "1", undelegate: false, nonce: 1, network })).toThrow(RangeError);
  });
});
