/**
 * Hyperliquid's protocol vault (HLP): the one vault a Kokoah trading key may deposit into.
 *
 * Trading keys never move funds, with one exception the product owner decided on 2026-10-05: deposits into HLP,
 * capped per deposit and per day, after a confirmation the signer shows itself (the 4-day lock-up named), and
 * withdrawals from any vault the account holds back into the account. A stolen trading key can at most park the
 * account's funds in HLP, where they stay the account's own. Deposits into any other vault stay with Hyperliquid's app.
 *
 * Vault transfers are L1 actions (`vaultTransfer`), which a wallet can only show as an opaque hash, so the main wallet
 * never signs them for Kokoah; the signer checks the structured action against these rules before hashing it.
 *
 * @module
 */
import { decDecimals, decSign, normalize, parseDec, PrecisionError, type Dec } from "../precision/decimal.js";

/**
 * HLP's address per network (Hyperliquid's docs and the Python SDK's vault transfer example). Mainnet's was checked with
 * `vaultDetails` on 2026-10-05: "Hyperliquidity Provider (HLP)", open to deposits, 4-day lock-up.
 */
export const HLP_VAULT_ADDRESSES: Readonly<Record<"mainnet" | "testnet", `0x${string}`>> = Object.freeze({
  mainnet: "0xdfc24b077bc1425ad1dea75bcb6f8158e10df303",
  testnet: "0xa15099a30bbf2e68942d6f4c43d70d04faeab0a0",
});

/** The limits on a trading key's HLP deposits (product owner, 2026-10-05). */
export const HLP_DEPOSIT_LIMITS = Object.freeze({
  /** Largest single deposit, in USDC. */
  perDepositUsd: 10_000,
  /** Most a trading key may deposit into HLP in any 24 hours (rolling), in USDC, counting deposits from any device. */
  dailyUsd: 25_000,
  /** Smallest deposit Kokoah offers, in USDC. */
  minDepositUsd: 5,
});

/** HLP's lock-up: a deposit can be withdrawn 4 days after it was made (Hyperliquid's docs). */
export const HLP_LOCKUP_DAYS = 4;

/** `vaultTransfer.usd` is USDC × 10^6, an integer. */
export const VAULT_USD_DECIMALS = 6;

/** True when `address` is HLP on `network`. */
export function isHlpVault(network: "mainnet" | "testnet", address: string): boolean {
  return HLP_VAULT_ADDRESSES[network] === address.toLowerCase();
}

/**
 * Converts a USDC amount to `vaultTransfer.usd` units (× 10^6), exactly. Accepts a decimal string or number with at
 * most 6 decimals; refuses zero, negatives, malformed input and amounts beyond a safe integer.
 *
 * @throws {RangeError}
 */
export function usdToVaultUnits(amount: string | number): number {
  return decimalToUnits(amount, VAULT_USD_DECIMALS, "USDC amount");
}

/** `vaultTransfer.usd` units back to a USDC decimal string ("12.5"). */
export function vaultUnitsToUsd(units: number): string {
  if (!Number.isSafeInteger(units) || units < 0) throw new RangeError("Vault units must be a non-negative safe integer");
  const s = units.toString().padStart(VAULT_USD_DECIMALS + 1, "0");
  const int = s.slice(0, -VAULT_USD_DECIMALS);
  const frac = s.slice(-VAULT_USD_DECIMALS).replace(/0+$/, "");
  return frac ? `${int}.${frac}` : int;
}

/**
 * Exact decimal → integer units (`amount × 10^decimals`). Shared by vault (USDC × 10^6) and staking (HYPE × 10^8)
 * amounts, whose integers are what gets signed.
 *
 * @throws {RangeError}
 */
export function decimalToUnits(amount: string | number, decimals: number, label = "Amount"): number {
  let d: Dec;
  try {
    d = normalize(parseDec(amount));
  } catch (e) {
    if (e instanceof PrecisionError) throw new RangeError(`${label} must be a decimal number`);
    throw e;
  }
  if (decSign(d) <= 0) throw new RangeError(`${label} must be above zero`);
  if (decDecimals(d) > decimals) throw new RangeError(`${label} has more than ${decimals} decimals`);
  const units = d.m * 10n ** BigInt(decimals - d.s);
  if (units > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError(`${label} is too large`);
  return Number(units);
}

/**
 * USDC deposited into `vault` by `user` since `sinceMs`, from Hyperliquid's `userNonFundingLedgerUpdates`
 * (`delta.type === "vaultDeposit"`). Entries it can't read are ignored only when they aren't vault deposits; an
 * unreadable vault deposit throws, so a cap is never checked against a partial sum.
 *
 * @throws {RangeError}
 */
export function vaultDepositsSince(ledger: unknown, vault: string, sinceMs: number): number {
  if (!Array.isArray(ledger)) throw new RangeError("The ledger must be an array");
  const target = vault.toLowerCase();
  let total = 0;
  for (const entry of ledger) {
    const e = entry as { time?: unknown; delta?: { type?: unknown; vault?: unknown; usdc?: unknown } } | null;
    if (!e || typeof e !== "object" || !e.delta || typeof e.delta !== "object") continue;
    if (e.delta.type !== "vaultDeposit") continue;
    if (typeof e.time !== "number" || typeof e.delta.vault !== "string" || (typeof e.delta.usdc !== "string" && typeof e.delta.usdc !== "number")) {
      throw new RangeError("A vault deposit in the ledger is unreadable");
    }
    if (e.time < sinceMs || e.delta.vault.toLowerCase() !== target) continue;
    const usd = Number(e.delta.usdc);
    if (!Number.isFinite(usd) || usd < 0) throw new RangeError("A vault deposit in the ledger is unreadable");
    total += usd;
  }
  return total;
}

/** What the signer knows when it checks a vault transfer. */
export interface VaultTransferCheck {
  network: "mainnet" | "testnet";
  /** The wire action about to be signed. */
  action: { type: string; vaultAddress?: unknown; isDeposit?: unknown; usd?: unknown };
  /** HLP deposits in the last 24 hours (Hyperliquid's ledger plus deposits this signer sent that the ledger may not show yet), USDC. */
  hlpDepositedLast24hUsd?: number;
  /** Withdrawals: the account's equity in that vault (Hyperliquid's `userVaultEquities`), USDC; undefined = not held. */
  heldEquityUsd?: number;
}

/** A rule a vault transfer breaks. */
export interface VaultTransferProblem {
  code: "VAULT_NOT_ALLOWED" | "VAULT_DEPOSIT_LIMIT" | "INVALID_SUBJECT";
  message: string;
}

/**
 * The rules for a trading key's `vaultTransfer` (see the module comment). Returns every rule the action breaks; an
 * empty list means it may be signed.
 */
export function vaultTransferProblems(check: VaultTransferCheck): VaultTransferProblem[] {
  const out: VaultTransferProblem[] = [];
  const { action } = check;
  if (action.type !== "vaultTransfer") return [{ code: "INVALID_SUBJECT", message: "Not a vault transfer." }];
  const keys = Object.keys(action).sort().join(",");
  if (keys !== "isDeposit,type,usd,vaultAddress") return [{ code: "INVALID_SUBJECT", message: "The vault transfer has unexpected fields." }];
  if (typeof action.vaultAddress !== "string" || !/^0x[0-9a-f]{40}$/.test(action.vaultAddress)) {
    return [{ code: "INVALID_SUBJECT", message: "The vault address must be a lowercase 20-byte hex address." }];
  }
  if (typeof action.isDeposit !== "boolean") return [{ code: "INVALID_SUBJECT", message: "isDeposit must be a boolean." }];
  if (typeof action.usd !== "number" || !Number.isSafeInteger(action.usd) || action.usd < 1) {
    return [{ code: "INVALID_SUBJECT", message: "usd must be a positive integer (USDC × 10^6)." }];
  }
  const usd = action.usd / 10 ** VAULT_USD_DECIMALS;
  if (action.isDeposit) {
    if (!isHlpVault(check.network, action.vaultAddress)) {
      out.push({ code: "VAULT_NOT_ALLOWED", message: "A trading key may deposit into HLP only. Deposit into other vaults on Hyperliquid's app." });
    }
    if (usd < HLP_DEPOSIT_LIMITS.minDepositUsd) {
      out.push({ code: "VAULT_DEPOSIT_LIMIT", message: `The smallest HLP deposit is ${HLP_DEPOSIT_LIMITS.minDepositUsd} USDC.` });
    }
    if (usd > HLP_DEPOSIT_LIMITS.perDepositUsd) {
      out.push({ code: "VAULT_DEPOSIT_LIMIT", message: `One HLP deposit can be at most ${HLP_DEPOSIT_LIMITS.perDepositUsd.toLocaleString("en-US")} USDC.` });
    }
    const today = check.hlpDepositedLast24hUsd;
    if (today === undefined || !Number.isFinite(today) || today < 0) {
      out.push({ code: "VAULT_DEPOSIT_LIMIT", message: "The signer could not read today's HLP deposits." });
    } else if (today + usd > HLP_DEPOSIT_LIMITS.dailyUsd + 1e-9) {
      const left = Math.max(0, HLP_DEPOSIT_LIMITS.dailyUsd - today);
      out.push({
        code: "VAULT_DEPOSIT_LIMIT",
        message: `At most ${HLP_DEPOSIT_LIMITS.dailyUsd.toLocaleString("en-US")} USDC can go into HLP in 24 hours; ${left.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC is left.`,
      });
    }
  } else {
    const held = check.heldEquityUsd;
    if (held === undefined) out.push({ code: "VAULT_NOT_ALLOWED", message: "This account holds nothing in that vault." });
    else if (!Number.isFinite(held) || usd > held + 1e-6) {
      out.push({ code: "VAULT_NOT_ALLOWED", message: "The withdrawal is larger than the account's equity in that vault." });
    }
  }
  return out;
}
