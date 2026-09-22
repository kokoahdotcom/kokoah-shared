/**
 * Shared setup for the testnet spikes. Every spike calls {@link setupTestnetSpike} first, which REFUSES to run unless:
 * - the target network is testnet (HL_NETWORK unset or "testnet"; the transport is built with isTestnet: true), and
 * - TESTNET_MAIN_PRIVATE_KEY is set to a 0x-prefixed 32-byte key of a funded TESTNET account.
 *
 * Run after `pnpm build` (spikes import the built package by name):
 *   TESTNET_MAIN_PRIVATE_KEY=0x... node spikes/01-approve-agent-valid-until.ts
 */
import { HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import {
  assertWriteAllowed,
  buildExchangeRequest,
  type ExchangeOutcome,
  MarketRegistry,
  MonotonicNonceManager,
  type NetworkConfig,
  parseExchangeResponse,
  type PreparedUserSignedAction,
  signatureFromHex,
  TESTNET,
} from "@kokoah/shared";
import { generatePrivateKey, type PrivateKeyAccount, privateKeyToAccount } from "viem/accounts";

export function refuse(message: string): never {
  console.error(`REFUSING TO RUN: ${message}`);
  process.exit(2);
}

export interface SpikeContext {
  network: NetworkConfig;
  main: PrivateKeyAccount;
  transport: HttpTransport;
  info: InfoClient;
  nonces: MonotonicNonceManager;
  /** POST a prepared body to testnet /exchange and parse the result (never throws on HL errors). */
  post: (body: unknown, expectedCount?: number) => Promise<{ raw: unknown; outcome: ExchangeOutcome }>;
  /** Sign a user-signed action with the main wallet and post it. */
  postUserSigned: (prepared: PreparedUserSignedAction) => Promise<{ raw: unknown; outcome: ExchangeOutcome }>;
  registry: () => Promise<MarketRegistry>;
  newAgent: () => PrivateKeyAccount;
}

export async function setupTestnetSpike(): Promise<SpikeContext> {
  const requested = process.env.HL_NETWORK;
  if (requested !== undefined && requested.trim().toLowerCase() !== "testnet") refuse(`HL_NETWORK=${requested}; spikes only run on testnet`);
  const network = TESTNET;
  if (!network.isTestnet || network.name !== "testnet" || !network.exchangeUrl.startsWith("https://api.hyperliquid-testnet.xyz/")) refuse("network is not testnet");
  assertWriteAllowed(network);
  const key = process.env.TESTNET_MAIN_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) refuse("set TESTNET_MAIN_PRIVATE_KEY (0x + 64 hex) to the key of a funded TESTNET account");
  const main = privateKeyToAccount(key as `0x${string}`);
  const transport = new HttpTransport({ isTestnet: true });
  if (!String(transport.apiUrl).includes("hyperliquid-testnet.xyz")) refuse(`transport points at ${String(transport.apiUrl)}`);
  const info = new InfoClient({ transport });
  const nonces = new MonotonicNonceManager();

  const state = await info.clearinghouseState({ user: main.address });
  console.log(`Testnet account ${main.address} — perps account value ${state.marginSummary.accountValue} USDC`);
  if (Number(state.marginSummary.accountValue) <= 0) console.warn("WARNING: account value is 0; many actions will fail with 'does not exist' until the account is funded.");

  const post: SpikeContext["post"] = async (body, expectedCount) => {
    let raw: unknown;
    try {
      raw = await transport.request("exchange", body);
    } catch (e) {
      raw = e instanceof Error ? e.message : String(e);
    }
    return { raw, outcome: parseExchangeResponse(raw, expectedCount) };
  };
  const postUserSigned: SpikeContext["postUserSigned"] = async (prepared) => {
    const hex = await main.signTypedData(prepared.typedData as Parameters<typeof main.signTypedData>[0]);
    const body = buildExchangeRequest({ network, action: prepared.action, nonce: prepared.nonce, signature: signatureFromHex(hex) });
    return await post(body);
  };
  const registry = async () => MarketRegistry.fromInfo({ meta: await info.meta() });
  const newAgent = () => privateKeyToAccount(generatePrivateKey());
  return { network, main, transport, info, nonces, post, postUserSigned, registry, newAgent };
}

export function show(label: string, value: unknown): void {
  console.log(`\n=== ${label}\n${JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2)}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A short unique agent name (≤ 16 chars) for spike runs. */
export function spikeAgentName(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 7)}`.slice(0, 16);
}
