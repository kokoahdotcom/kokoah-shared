/**
 * Hyperliquid network configuration (mainnet / testnet) and the mainnet write guard.
 *
 * Sources:
 * - Endpoints: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api (REST `/info`, `/exchange`, WS `/ws`).
 * - L1 signing uses the phantom-agent `source` "a" (mainnet) or "b" (testnet); user-signed actions carry
 *   `hyperliquidChain: "Mainnet" | "Testnet"` (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/signing).
 *
 * The library defaults to **testnet** everywhere. Anything that produces a sendable `/exchange` request must call
 * {@link assertWriteAllowed}; mainnet writes require an explicit `allowMainnetWrites: true`.
 *
 * @module
 */

/** Network name. */
export type HlNetworkName = "mainnet" | "testnet";

/** Everything needed to talk to and sign for one Hyperliquid network. */
export interface NetworkConfig {
  readonly name: HlNetworkName;
  readonly isTestnet: boolean;
  /** Base REST URL, e.g. `https://api.hyperliquid-testnet.xyz`. */
  readonly apiUrl: string;
  /** `POST` endpoint for read-only queries. */
  readonly infoUrl: string;
  /** `POST` endpoint for signed actions. Guarded by {@link assertWriteAllowed}. */
  readonly exchangeUrl: string;
  /** WebSocket URL. */
  readonly wsUrl: string;
  /** Phantom-agent `source` field for L1 signatures: "a" = mainnet, "b" = testnet. */
  readonly signatureSource: "a" | "b";
  /** `hyperliquidChain` field for user-signed actions. */
  readonly hyperliquidChain: "Mainnet" | "Testnet";
  /**
   * Default EIP-712 `signatureChainId` (hex) for user-signed actions. Any chain is accepted by HL; browser wallets
   * usually want the chain they are connected to, so callers should pass the wallet's chain when they know it.
   * Defaults: Arbitrum One (0xa4b1) on mainnet, Arbitrum Sepolia (0x66eee) on testnet.
   */
  readonly defaultSignatureChainId: `0x${string}`;
  /** Must be explicitly `true` to allow producing signed `/exchange` requests on mainnet. */
  readonly allowMainnetWrites: boolean;
}

/** EIP-712 chain id of the L1 "Exchange" domain (fixed by HL; not a real chain). */
export const HL_L1_SIGNING_CHAIN_ID = 1337;

/** Mainnet base URL. */
export const MAINNET_API_URL = "https://api.hyperliquid.xyz";
/** Testnet base URL. */
export const TESTNET_API_URL = "https://api.hyperliquid-testnet.xyz";
/** Mainnet WebSocket URL. */
export const MAINNET_WS_URL = "wss://api.hyperliquid.xyz/ws";
/** Testnet WebSocket URL. */
export const TESTNET_WS_URL = "wss://api.hyperliquid-testnet.xyz/ws";

/** Mainnet configuration with writes blocked. Use {@link getNetworkConfig} to opt in to mainnet writes. */
export const MAINNET: NetworkConfig = Object.freeze({
  name: "mainnet",
  isTestnet: false,
  apiUrl: MAINNET_API_URL,
  infoUrl: `${MAINNET_API_URL}/info`,
  exchangeUrl: `${MAINNET_API_URL}/exchange`,
  wsUrl: MAINNET_WS_URL,
  signatureSource: "a",
  hyperliquidChain: "Mainnet",
  defaultSignatureChainId: "0xa4b1",
  allowMainnetWrites: false,
});

/** Testnet configuration (the default). */
export const TESTNET: NetworkConfig = Object.freeze({
  name: "testnet",
  isTestnet: true,
  apiUrl: TESTNET_API_URL,
  infoUrl: `${TESTNET_API_URL}/info`,
  exchangeUrl: `${TESTNET_API_URL}/exchange`,
  wsUrl: TESTNET_WS_URL,
  signatureSource: "b",
  hyperliquidChain: "Testnet",
  defaultSignatureChainId: "0x66eee",
  allowMainnetWrites: false,
});

/** The default network: testnet. */
export const DEFAULT_NETWORK: NetworkConfig = TESTNET;

/** Options for {@link getNetworkConfig}. */
export interface NetworkConfigOptions {
  /** Explicit opt-in for mainnet writes. Ignored on testnet. */
  allowMainnetWrites?: boolean;
  /** Override the REST base URL (e.g. a data provider for `/info`). `/exchange` is derived from it. */
  apiUrl?: string;
  /** Override the WebSocket URL. */
  wsUrl?: string;
  /** Override the default EIP-712 signatureChainId for user-signed actions. */
  defaultSignatureChainId?: `0x${string}`;
}

/**
 * Returns a network configuration. Defaults to testnet.
 *
 * @example
 * getNetworkConfig();                                          // testnet
 * getNetworkConfig("mainnet");                                 // mainnet, writes blocked
 * getNetworkConfig("mainnet", { allowMainnetWrites: true });   // mainnet, writes allowed
 */
export function getNetworkConfig(name: HlNetworkName = "testnet", options: NetworkConfigOptions = {}): NetworkConfig {
  const base = name === "mainnet" ? MAINNET : TESTNET;
  const apiUrl = (options.apiUrl ?? base.apiUrl).replace(/\/+$/, "");
  return Object.freeze({
    ...base,
    apiUrl,
    infoUrl: `${apiUrl}/info`,
    exchangeUrl: `${apiUrl}/exchange`,
    wsUrl: options.wsUrl ?? base.wsUrl,
    defaultSignatureChainId: options.defaultSignatureChainId ?? base.defaultSignatureChainId,
    allowMainnetWrites: name === "mainnet" ? options.allowMainnetWrites === true : false,
  });
}

/**
 * Parses a network name from an environment value. Anything other than exactly "mainnet" (case-insensitive)
 * yields "testnet", so a missing or misspelled variable can never select mainnet.
 */
export function parseNetworkName(value: string | undefined | null): HlNetworkName {
  return typeof value === "string" && value.trim().toLowerCase() === "mainnet" ? "mainnet" : "testnet";
}

/** Thrown by {@link assertWriteAllowed} when a mainnet write was not explicitly allowed. */
export class MainnetWriteBlockedError extends Error {
  readonly code = "MAINNET_WRITE_BLOCKED";
  constructor(message = "Refusing to produce a mainnet /exchange request: set allowMainnetWrites: true explicitly.") {
    super(message);
    this.name = "MainnetWriteBlockedError";
  }
}

/**
 * Throws unless the configuration allows writes: testnet always does; mainnet only with
 * `allowMainnetWrites: true`. Call this before building or sending any `/exchange` request.
 *
 * @throws {MainnetWriteBlockedError}
 */
export function assertWriteAllowed(config: Pick<NetworkConfig, "isTestnet" | "allowMainnetWrites" | "name">): void {
  if (config.isTestnet && config.name === "testnet") return;
  if (config.name === "mainnet" && !config.isTestnet && config.allowMainnetWrites === true) return;
  throw new MainnetWriteBlockedError();
}

/** True when {@link assertWriteAllowed} would pass. */
export function isWriteAllowed(config: Pick<NetworkConfig, "isTestnet" | "allowMainnetWrites" | "name">): boolean {
  try {
    assertWriteAllowed(config);
    return true;
  } catch {
    return false;
  }
}
