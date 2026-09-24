/**
 * Sub-accounts ("strategy accounts"): reading Hyperliquid's `subAccounts` info and checking that an account really
 * belongs to a master.
 *
 * Hyperliquid sub-accounts have no private key. The master's agent key trades for one by setting `vaultAddress` on
 * the request (exchange endpoint docs). HL lets the same field act for a vault the master leads, so a signer must
 * never trust a caller's list of accounts: it reads `{"type":"subAccounts","user":master}` itself and allows
 * `vaultAddress` only for an address listed there with `master` equal to the signed-in master. Vaults are never listed
 * there, so they stay denied.
 *
 * {@link SubAccountOwnership} is the small cache the signer frame, the signer service and the backend share: it keeps
 * each master's list for `ttlMs` (default 30 s), and a miss on a list older than `missRefreshMs` (default 5 s) reads
 * HL again, so a sub-account created a moment ago is found without re-reading HL on every order. Sub-accounts cannot
 * move to another master, so a cached "owned" answer never becomes wrong; only "not owned" can go stale, and that
 * only denies.
 *
 * Pure apart from the injected loader; subpath export only (`@kokoah/shared/subaccounts`).
 *
 * @module
 */

/** HL allows at most 50 sub-accounts per master (sub-accounts docs). */
export const MAX_SUB_ACCOUNTS = 50;
/** Longest sub-account name Kokoah shows (HL's own limit is not documented; longer names are cut). */
export const MAX_SUB_ACCOUNT_NAME_LENGTH = 64;
/** Default time a master's list is trusted. */
export const SUB_ACCOUNT_TTL_MS = 30_000;
/** Default age after which a miss re-reads HL. */
export const SUB_ACCOUNT_MISS_REFRESH_MS = 5_000;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

/** A sub-account as Kokoah uses it (addresses lowercase). */
export interface SubAccount {
  address: `0x${string}`;
  /** HL's name for it (trimmed, at most {@link MAX_SUB_ACCOUNT_NAME_LENGTH} characters; may be empty). */
  name: string;
  master: `0x${string}`;
}

/** True for a 20-byte hex address. */
export function isAccountAddress(value: unknown): value is `0x${string}` {
  return typeof value === "string" && ADDRESS.test(value);
}

/** The account an action is for: the sub-account in `vaultAddress` when set, else the master (lowercase). */
export function accountOf(master: string, vaultAddress?: string | null): `0x${string}` {
  const account = vaultAddress ?? master;
  if (!isAccountAddress(account)) throw new RangeError("account must be a 20-byte hex address");
  return account.toLowerCase() as `0x${string}`;
}

/**
 * The sub-accounts of `master` in an HL `subAccounts` answer (`null` or an array of
 * `{name, subAccountUser, master, clearinghouseState, spotState}`). Fails closed: entries that are malformed, name
 * another master, repeat an address, are the master itself or the zero address are left out. At most
 * {@link MAX_SUB_ACCOUNTS} are kept. Throws only when the answer is neither `null` nor an array (an HL error).
 */
export function parseSubAccounts(raw: unknown, master: string): SubAccount[] {
  if (!isAccountAddress(master)) throw new RangeError("master must be a 20-byte hex address");
  if (raw === null) return [];
  if (!Array.isArray(raw)) throw new TypeError("subAccounts answer must be null or an array");
  const me = master.toLowerCase();
  const seen = new Set<string>();
  const out: SubAccount[] = [];
  for (const entry of raw as unknown[]) {
    if (out.length >= MAX_SUB_ACCOUNTS) break;
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as { subAccountUser?: unknown; master?: unknown; name?: unknown };
    if (!isAccountAddress(e.subAccountUser) || !isAccountAddress(e.master)) continue;
    const address = e.subAccountUser.toLowerCase();
    if (e.master.toLowerCase() !== me || address === me || address === ZERO || seen.has(address)) continue;
    seen.add(address);
    const name = typeof e.name === "string" ? e.name.trim().slice(0, MAX_SUB_ACCOUNT_NAME_LENGTH) : "";
    out.push({ address: address as `0x${string}`, name, master: me as `0x${string}` });
  }
  return out;
}

/** Thrown by {@link SubAccountOwnership} when HL could not be read (the caller must deny, never allow). */
export class SubAccountLookupError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SubAccountLookupError";
  }
}

/** Options of {@link SubAccountOwnership}. */
export interface SubAccountOwnershipOptions {
  /** Reads HL `{"type":"subAccounts","user":master}` and returns the raw answer. Must use the caller's own HL client. */
  load: (master: `0x${string}`) => Promise<unknown>;
  now?: () => number;
  ttlMs?: number;
  missRefreshMs?: number;
  /** Masters kept at once (oldest dropped first). Default 1,000. */
  maxMasters?: number;
}

interface Entry {
  at: number;
  list: SubAccount[];
}

/** Cached, fail-closed sub-account ownership checks for one HL network. */
export class SubAccountOwnership {
  private readonly load: SubAccountOwnershipOptions["load"];
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly missRefreshMs: number;
  private readonly maxMasters: number;
  private readonly entries = new Map<string, Entry>();
  private readonly inFlight = new Map<string, Promise<Entry>>();

  constructor(options: SubAccountOwnershipOptions) {
    this.load = options.load;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SUB_ACCOUNT_TTL_MS;
    this.missRefreshMs = Math.min(options.missRefreshMs ?? SUB_ACCOUNT_MISS_REFRESH_MS, this.ttlMs);
    this.maxMasters = Math.max(1, options.maxMasters ?? 1_000);
  }

  /** The master's sub-accounts (cached up to `ttlMs`). Throws {@link SubAccountLookupError} when HL can't be read. */
  async list(master: string): Promise<SubAccount[]> {
    const key = normalize(master);
    const cached = this.fresh(key, this.ttlMs);
    return [...(cached ?? (await this.refresh(key))).list];
  }

  /**
   * The sub-account `account` of `master`, or null when HL does not list it for that master. The master itself is
   * never returned (it is not a sub-account). Throws {@link SubAccountLookupError} when HL can't be read.
   */
  async find(master: string, account: string): Promise<SubAccount | null> {
    const key = normalize(master);
    const target = normalize(account);
    if (target === key) return null;
    let entry = this.fresh(key, this.ttlMs);
    let hit = entry?.list.find((s) => s.address === target);
    if (hit) return { ...hit };
    // Unknown here: read HL again unless the list is only a few seconds old.
    if (!entry || this.now() - entry.at >= this.missRefreshMs) entry = await this.refresh(key);
    hit = entry.list.find((s) => s.address === target);
    return hit ? { ...hit } : null;
  }

  /** True when HL lists `account` as a sub-account of `master`. Throws {@link SubAccountLookupError} when HL can't be read. */
  async isOwned(master: string, account: string): Promise<boolean> {
    return (await this.find(master, account)) !== null;
  }

  /** Forgets one master's list, or every list. */
  invalidate(master?: string): void {
    if (master === undefined) this.entries.clear();
    else this.entries.delete(normalize(master));
  }

  private fresh(key: string, maxAge: number): Entry | undefined {
    const e = this.entries.get(key);
    if (!e) return undefined;
    const age = this.now() - e.at;
    // A clock that went backwards makes the entry untrustworthy too.
    return age >= 0 && age < maxAge ? e : undefined;
  }

  private refresh(key: `0x${string}`): Promise<Entry> {
    const running = this.inFlight.get(key);
    if (running) return running;
    const p = (async () => {
      let raw: unknown;
      try {
        raw = await this.load(key);
      } catch (e) {
        throw new SubAccountLookupError("Could not read the sub-accounts from Hyperliquid", { cause: e });
      }
      let list: SubAccount[];
      try {
        list = parseSubAccounts(raw, key);
      } catch (e) {
        throw new SubAccountLookupError("Hyperliquid returned an unreadable sub-accounts answer", { cause: e });
      }
      const entry = { at: this.now(), list };
      this.entries.delete(key);
      this.entries.set(key, entry);
      while (this.entries.size > this.maxMasters) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
      return entry;
    })();
    this.inFlight.set(key, p);
    const clear = () => {
      if (this.inFlight.get(key) === p) this.inFlight.delete(key);
    };
    p.then(clear, clear);
    return p;
  }
}

function normalize(address: string): `0x${string}` {
  if (!isAccountAddress(address)) throw new RangeError("address must be a 20-byte hex address");
  return address.toLowerCase() as `0x${string}`;
}
