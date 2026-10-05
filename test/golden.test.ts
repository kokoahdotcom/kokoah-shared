/**
 * Golden vectors: our signing path must reproduce the official Python SDK exactly.
 * See scripts/golden/README.md.
 */
import { readFileSync } from "node:fs";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  type ActionIntentInput,
  buildAccountMode,
  buildApproveAgent,
  buildApproveBuilderFee,
  buildStakingDeposit,
  buildStakingWithdraw,
  buildTokenDelegate,
  HLP_VAULT_ADDRESSES,
  buildSendAsset,
  buildWithdraw,
  compileAccountAction,
  compileAction,
  getNetworkConfig,
  hashL1Action,
  MarketRegistry,
  parseAgentName,
  recoverL1Signer,
  recoverUserSignedSigner,
  signatureFromHex,
  signL1Action,
  signUserSignedAction,
  type PreparedUserSignedAction,
} from "../src/index.js";
import {
  ApproveAgentTypes,
  ApproveBuilderFeeTypes,
  CDepositTypes,
  CWithdrawTypes,
  SendAssetTypes,
  TokenDelegateTypes,
  UserSetAbstractionTypes,
  Withdraw3Types,
} from "@nktkas/hyperliquid/api/exchange";

interface Vector {
  name: string;
  kind: "l1" | "userSigned";
  isMainnet: boolean;
  privateKey: `0x${string}`;
  signer: string;
  nonce: number;
  vaultAddress?: `0x${string}` | null;
  expiresAfter?: number | null;
  action: Record<string, unknown>;
  connectionId?: string;
  signature: { r: string; s: string; v: number };
}

const file = JSON.parse(readFileSync(new URL("./golden/vectors.json", import.meta.url), "utf8")) as { vectors: Vector[]; pythonSdkVersion: string };
const vectors = file.vectors;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const registry = MarketRegistry.fromInfo({
  allPerpMetas: fixture("mainnet-allPerpMetas.json"),
  perpDexs: fixture("mainnet-perpDexs.json"),
  spotMeta: fixture("mainnet-spotMeta.json"),
});

const BUILDER = "0x1111111111111111111111111111111111111111" as const;
const VAULT = "0x2222222222222222222222222222222222222222" as const;
const NONCE = 1790000000000;
const C = (n: number) => `0x6b6f01010000000000000000000000${n.toString(16).padStart(2, "0")}` as `0x${string}`;

function sameSig(ours: { r: string; s: string; v: number }, theirs: { r: string; s: string; v: number }): void {
  // Python's to_hex() drops leading zeros of r/s, so compare as integers.
  expect(BigInt(ours.r)).toBe(BigInt(theirs.r));
  expect(BigInt(ours.s)).toBe(BigInt(theirs.s));
  expect(ours.v).toBe(theirs.v);
}

function vec(name: string): Vector {
  const v = vectors.find((x) => x.name === name);
  if (!v) throw new Error(`missing vector ${name}`);
  return v;
}

describe("golden vectors file", () => {
  it("was produced by the Python SDK and covers L1 and user-signed actions", () => {
    expect(file.pythonSdkVersion).toBe("0.24.0");
    expect(vectors.filter((v) => v.kind === "l1").length).toBeGreaterThanOrEqual(15);
    expect(vectors.filter((v) => v.kind === "userSigned").length).toBeGreaterThanOrEqual(10);
    for (const type of ["sendAsset", "userSetAbstraction"]) expect(vectors.some((v) => v.action.type === type)).toBe(true);
    expect(vectors.some((v) => v.action.type === "sendAsset" && v.action.fromSubAccount !== "")).toBe(true);
  });
});

describe("L1 signatures match the Python SDK", () => {
  for (const v of vectors.filter((x) => x.kind === "l1")) {
    it(v.name, async () => {
      const params = {
        action: v.action,
        nonce: v.nonce,
        vaultAddress: v.vaultAddress ?? undefined,
        expiresAfter: v.expiresAfter ?? undefined,
      };
      expect(hashL1Action(params)).toBe(v.connectionId);
      const wallet = privateKeyToAccount(v.privateKey);
      expect(wallet.address.toLowerCase()).toBe(v.signer);
      const sig = await signL1Action({ ...params, wallet, network: { isTestnet: !v.isMainnet } });
      sameSig(sig, v.signature);
      const recovered = await recoverL1Signer({ ...params, network: { isTestnet: !v.isMainnet }, signature: sig });
      expect(recovered.toLowerCase()).toBe(v.signer);
      // Signing on the other network must give a different signature (source "a" vs "b").
      const other = await signL1Action({ ...params, wallet, network: { isTestnet: v.isMainnet } });
      expect(other.r).not.toBe(sig.r);
    });
  }
});

describe("compileAction produces the exact wire actions the Python SDK signs", () => {
  const builder = (f: number) => ({ address: BUILDER, feeTenthsBps: f });
  const cases: Array<{ name: string; intent: ActionIntentInput; builderF?: number; mid?: string; vault?: string }> = [
    {
      name: "order_limit_builder_mainnet",
      intent: { kind: "order", coin: "BTC", side: "buy", orderType: "limit", size: "0.001", price: "100000", tif: "Gtc", cloid: C(1), origin: "manual" },
      builderF: 25,
    },
    {
      name: "order_normal_tpsl_mainnet",
      intent: {
        kind: "order",
        coin: "ETH",
        side: "buy",
        orderType: "limit",
        size: 0.5,
        price: 2500.5,
        cloid: C(1),
        takeProfit: { triggerPrice: "2700", cloid: C(2) },
        stopLoss: { triggerPrice: "2400", cloid: C(3) },
        origin: "manual",
      },
      builderF: 10,
    },
    {
      name: "order_hip3_market_ioc_testnet",
      intent: { kind: "order", coin: "xyz:SP500", side: "sell", orderType: "market", size: "0.25", slippageBps: 100, cloid: C(4), origin: "manual" },
      builderF: 25,
      mid: "6789.1",
    },
    {
      name: "order_vault_mainnet",
      intent: { kind: "order", coin: "SOL", side: "sell", orderType: "limit", size: "1.50", price: "180.250", reduceOnly: true, cloid: C(5), origin: "manual", vaultAddress: VAULT },
      builderF: 25,
      vault: VAULT,
    },
    {
      name: "order_expires_after_testnet",
      intent: { kind: "order", coin: "kPEPE", side: "buy", orderType: "limit", size: "1000", price: "0.012345", tif: "Alo", cloid: C(6), origin: "manual" },
    },
    {
      name: "order_vault_and_expires_after_mainnet",
      intent: { kind: "order", coin: "HYPE", side: "buy", orderType: "limit", size: "2", price: "45.123", cloid: C(1), origin: "manual", vaultAddress: VAULT },
      builderF: 100,
      vault: VAULT,
    },
    {
      name: "order_stop_limit_position_tpsl_mainnet",
      intent: {
        kind: "order",
        coin: "BTC",
        side: "sell",
        orderType: "stopLimit",
        size: "0.002",
        price: "89500",
        triggerPrice: "90000",
        reduceOnly: true,
        positionTpsl: true,
        cloid: C(7),
        origin: "guardian",
      },
      builderF: 25,
    },
    {
      name: "cancel_mainnet",
      intent: {
        kind: "cancel",
        cancels: [
          { coin: "BTC", oid: 123456789012 },
          { coin: "xyz:SP500", oid: 42 },
        ],
        origin: "manual",
      },
    },
    { name: "cancel_by_cloid_testnet", intent: { kind: "cancel", cancels: [{ coin: "ETH", cloid: C(1) }], origin: "manual" } },
    { name: "update_leverage_mainnet", intent: { kind: "updateLeverage", coin: "xyz:SP500", leverage: 20, marginMode: "isolated", origin: "manual" } },
    { name: "update_isolated_margin_mainnet", intent: { kind: "updateIsolatedMargin", coin: "SOL", amountUsd: "-2.5", origin: "manual" } },
    { name: "schedule_cancel_set_mainnet", intent: { kind: "scheduleCancel", time: NONCE + 60_000, origin: "manual" } },
    { name: "schedule_cancel_clear_testnet", intent: { kind: "scheduleCancel", origin: "manual" } },
    {
      name: "modify_by_oid_mainnet",
      intent: {
        kind: "modify",
        target: { oid: 987654321 },
        order: { coin: "ETH", side: "buy", orderType: "limit", size: "0.5", price: "2490", tif: "Gtc", cloid: C(8) },
        origin: "manual",
      },
    },
    {
      name: "modify_by_cloid_testnet",
      intent: {
        kind: "modify",
        target: { cloid: C(7) },
        order: { coin: "BTC", side: "sell", orderType: "stopMarket", size: "0.002", triggerPrice: "90000", reduceOnly: true, cloid: C(8) },
        origin: "guardian",
      },
    },
    { name: "noop_mainnet", intent: { kind: "noop", origin: "manual" } },
    // Convert stablecoins: the builder is configured, and the compiler leaves it off the spot buy.
    {
      name: "spot_stablecoin_buy_no_builder_mainnet",
      intent: { kind: "order", coin: "@166", side: "buy", orderType: "limit", tif: "Ioc", size: "25", price: "1.0005", cloid: C(1), origin: "manual" },
      builderF: 25,
    },
    {
      name: "spot_stablecoin_sell_builder_testnet",
      intent: { kind: "order", coin: "@166", side: "sell", orderType: "limit", tif: "Ioc", size: "12.50", price: "0.9995", cloid: C(2), origin: "manual" },
      builderF: 25,
    },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const v = vec(c.name);
      const compiled = compileAction(c.intent, {
        registry,
        builder: c.builderF !== undefined ? builder(c.builderF) : null,
        ...(c.mid !== undefined ? { getMidPrice: () => c.mid } : {}),
      });
      // Key order matters for msgpack: compare serialized JSON, not deep equality.
      expect(JSON.stringify(compiled.action)).toBe(JSON.stringify(v.action));
      expect(compiled.vaultAddress ?? null).toBe(v.vaultAddress ?? null);
      const sig = await signL1Action({
        wallet: privateKeyToAccount(v.privateKey),
        network: { isTestnet: !v.isMainnet },
        action: compiled.action,
        nonce: v.nonce,
        vaultAddress: compiled.vaultAddress,
        expiresAfter: v.expiresAfter ?? undefined,
      });
      sameSig(sig, v.signature);
    });
  }
});

describe("compileAccountAction produces the exact setReferrer the Python SDK signs", () => {
  for (const name of ["set_referrer_mainnet", "set_referrer_testnet"]) {
    it(name, async () => {
      const v = vec(name);
      const compiled = compileAccountAction({ kind: "setReferrer", origin: "manual" }, { referralCode: "KOKOAH" });
      expect(JSON.stringify(compiled.action)).toBe(JSON.stringify(v.action));
      const sig = await signL1Action({
        wallet: privateKeyToAccount(v.privateKey),
        network: { isTestnet: !v.isMainnet },
        action: compiled.action as unknown as Record<string, unknown>,
        nonce: v.nonce,
        expiresAfter: v.expiresAfter ?? undefined,
      });
      sameSig(sig, v.signature);
    });
  }
});

describe("compileAccountAction produces the startFeeTrial actions signed with the Python SDK's L1 path", () => {
  const vip = [
    { cross: "0.0004", add: "0.00012" },
    { cross: "0.00035", add: "0.00008" },
    { cross: "0.0003", add: "0.00004" },
    { cross: "0.00028", add: "0.0" },
  ];
  for (const [name, tier] of [
    ["start_fee_trial_mainnet", 1],
    ["start_fee_trial_top_tier_testnet", 4],
  ] as const) {
    it(name, async () => {
      const v = vec(name);
      const compiled = compileAccountAction({ kind: "startFeeTrial", origin: "manual", tier }, { feeTiers: vip });
      expect(JSON.stringify(compiled.action)).toBe(JSON.stringify(v.action));
      const sig = await signL1Action({
        wallet: privateKeyToAccount(v.privateKey),
        network: { isTestnet: !v.isMainnet },
        action: compiled.action as unknown as Record<string, unknown>,
        nonce: v.nonce,
        expiresAfter: v.expiresAfter ?? undefined,
      });
      sameSig(sig, v.signature);
    });
  }
});

describe("compileAccountAction produces the exact vaultTransfer actions the Python SDK signs", () => {
  for (const [name, intent, hlp] of [
    ["hlp_deposit_mainnet", { kind: "hlpDeposit", origin: "manual", usd: "250" }, HLP_VAULT_ADDRESSES.mainnet],
    ["hlp_deposit_testnet", { kind: "hlpDeposit", origin: "manual", usd: "5" }, HLP_VAULT_ADDRESSES.testnet],
    ["vault_withdraw_testnet", { kind: "vaultWithdraw", origin: "manual", vaultAddress: "0x2222222222222222222222222222222222222222", usd: "12.5" }, null],
  ] as const) {
    it(name, async () => {
      const v = vec(name);
      const compiled = compileAccountAction(intent, hlp ? { hlpVaultAddress: hlp } : {});
      expect(JSON.stringify(compiled.action)).toBe(JSON.stringify(v.action));
      const sig = await signL1Action({
        wallet: privateKeyToAccount(v.privateKey),
        network: { isTestnet: !v.isMainnet },
        action: compiled.action as unknown as Record<string, unknown>,
        nonce: v.nonce,
        expiresAfter: v.expiresAfter ?? undefined,
      });
      sameSig(sig, v.signature);
    });
  }
});

/** Staking `wei` (HYPE × 10^8) as a HYPE decimal string, exactly. */
function weiToHype(wei: number): string {
  const s = wei.toString().padStart(9, "0");
  const frac = s.slice(-8).replace(/0+$/, "");
  return frac ? `${s.slice(0, -8)}.${frac}` : s.slice(0, -8);
}

describe("user-signed signatures match the Python SDK", () => {
  function prepare(v: Vector): { prepared: PreparedUserSignedAction; types: Record<string, ReadonlyArray<{ name: string; type: string }>> } {
    const network = getNetworkConfig(v.isMainnet ? "mainnet" : "testnet");
    const a = v.action as Record<string, string | number>;
    const signatureChainId = a.signatureChainId as `0x${string}`;
    switch (a.type) {
      case "approveAgent": {
        const { name, validUntil } = parseAgentName(String(a.agentName));
        return {
          prepared: buildApproveAgent({
            agentAddress: a.agentAddress as `0x${string}`,
            agentName: name,
            validUntil: validUntil as number,
            nonce: v.nonce,
            network,
            signatureChainId,
          }),
          types: ApproveAgentTypes,
        };
      }
      case "approveBuilderFee": {
        const pct = Number(String(a.maxFeeRate).replace("%", ""));
        return {
          prepared: buildApproveBuilderFee({ builder: a.builder as `0x${string}`, maxFeeTenthsBps: Math.round(pct * 1000), nonce: v.nonce, network, signatureChainId }),
          types: ApproveBuilderFeeTypes,
        };
      }
      case "withdraw3":
        return {
          prepared: buildWithdraw({ destination: a.destination as `0x${string}`, amount: String(a.amount), nonce: v.nonce, network, signatureChainId }),
          types: Withdraw3Types,
        };
      case "sendAsset":
        return {
          prepared: buildSendAsset({
            destination: a.destination as `0x${string}`,
            sourceDex: String(a.sourceDex),
            destinationDex: String(a.destinationDex),
            token: String(a.token),
            amount: String(a.amount),
            nonce: v.nonce,
            network,
            signatureChainId,
            ...(a.fromSubAccount ? { fromSubAccount: a.fromSubAccount as `0x${string}` } : {}),
          }),
          types: SendAssetTypes,
        };
      case "userSetAbstraction":
        return {
          prepared: buildAccountMode({
            user: a.user as `0x${string}`,
            abstraction: a.abstraction as "disabled" | "unifiedAccount",
            nonce: v.nonce,
            network,
            signatureChainId,
          }),
          types: UserSetAbstractionTypes,
        };
      case "tokenDelegate":
        return {
          prepared: buildTokenDelegate({
            validator: a.validator as `0x${string}`,
            amount: weiToHype(Number(a.wei)),
            undelegate: Boolean(a.isUndelegate),
            nonce: v.nonce,
            network,
            signatureChainId,
          }),
          types: TokenDelegateTypes,
        };
      case "cDeposit":
        return { prepared: buildStakingDeposit({ amount: weiToHype(Number(a.wei)), nonce: v.nonce, network, signatureChainId }), types: CDepositTypes };
      case "cWithdraw":
        return { prepared: buildStakingWithdraw({ amount: weiToHype(Number(a.wei)), nonce: v.nonce, network, signatureChainId }), types: CWithdrawTypes };
      default:
        throw new Error(`unexpected ${String(a.type)}`);
    }
  }

  for (const v of vectors.filter((x) => x.kind === "userSigned")) {
    it(v.name, async () => {
      const { prepared, types } = prepare(v);
      // Every signed field equals what Python signed.
      for (const [k, value] of Object.entries(prepared.typedData.message)) {
        const theirs = v.action[k];
        expect(typeof value === "string" ? value.toLowerCase() : value).toBe(typeof theirs === "string" ? theirs.toLowerCase() : theirs);
      }
      expect(prepared.typedData.domain.chainId).toBe(parseInt(String(v.action.signatureChainId), 16));
      const wallet = privateKeyToAccount(v.privateKey);
      // Path 1: browser-style signing of our typed data (what a main wallet does).
      const hex = await wallet.signTypedData(prepared.typedData as Parameters<typeof wallet.signTypedData>[0]);
      sameSig(signatureFromHex(hex), v.signature);
      // Path 2: the SDK wrapper.
      const sig = await signUserSignedAction({ wallet, action: prepared.action as { signatureChainId: `0x${string}` } & Record<string, unknown>, types });
      sameSig(sig, v.signature);
      expect((await recoverUserSignedSigner({ typedData: prepared.typedData, signature: sig })).toLowerCase()).toBe(v.signer);
    });
  }
});
