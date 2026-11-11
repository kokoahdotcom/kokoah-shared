/**
 * Operator alerts shared by the backend and the signer service: what an alert is, how its text is cleaned before it
 * leaves the server, how repeats are grouped, and how a batch is posted to a Discord webhook (or a Slack-compatible
 * one) within the receiver's limits.
 *
 * - **Nothing secret or personal leaves.** {@link scrubOpsText} removes credentials in URLs, query strings, bearer
 *   tokens, `key=value` secrets, recovery phrases ({@link scrubPhrases}), known API-key and token formats (OpenAI/Anthropic `sk-`, Google `AIza`, Slack, GitHub,
 *   Telegram bot tokens, JWTs, Discord webhook URLs), PEM blocks, private keys, signatures and long hex or base64,
 *   wallet addresses, e-mail and IP addresses, and control characters. Alerts go to a third party (Discord).
 * - **One bug, one message.** {@link opsFingerprint} groups an error by where it happened and its message with the
 *   variable parts (numbers, ids, hex) taken out; repeats are counted and reported after a cooldown by severity
 *   ({@link OPS_COOLDOWN_MS}), never one message each.
 * - **Untrusted text can't ping or link.** Messages carry text from errors and from browsers' reports: it goes into
 *   code blocks with backticks neutralised, and `allowed_mentions` is empty except for the configured mentions on
 *   critical alerts and critical health problems.
 * - **Within Discord's limits.** Title 256, description 4096, field 1024, footer 2048, 6000 characters and 10 embeds per
 *   message, 2000 for `content`; batches are split to fit. 429 answers carry the wait ({@link postOpsWebhook}).
 * - **Partly sent is partly sent.** {@link sendOpsBatch} says which alerts and problems went out before a failure, so
 *   a sender marks exactly those and never posts a message (or its mention) twice.
 */

import { czech, english, french, italian, japanese, korean, portuguese, simplifiedChinese, spanish, traditionalChinese } from "viem/accounts";

export type OpsSeverity = "critical" | "error" | "warning";

/** Rank for ordering and storage: higher is worse. */
export const OPS_SEVERITY_RANK: Readonly<Record<OpsSeverity, number>> = { critical: 3, error: 2, warning: 1 };
export const opsSeverityOfRank = (rank: number): OpsSeverity => (rank >= 3 ? "critical" : rank === 2 ? "error" : "warning");

/** How long a repeated alert waits before it is posted again (with how many times it happened meanwhile). */
export const OPS_COOLDOWN_MS: Readonly<Record<OpsSeverity, number>> = { critical: 5 * 60_000, error: 15 * 60_000, warning: 60 * 60_000 };

export type OpsContext = Record<string, string | number | boolean | null>;

export interface OpsEvent {
  severity: OpsSeverity;
  /** The process or area it came from, e.g. `api`, `worker`, `signer`, `browser`. */
  source: string;
  /** One line: what happened. */
  title: string;
  /** The error text and stack frames (shown in a code block). */
  detail?: string;
  context?: OpsContext;
  /** Groups repeats; computed from source, title and detail when absent. */
  fingerprint?: string;
}

/** One grouped alert ready to post. */
export interface OpsAlert {
  severity: OpsSeverity;
  source: string;
  title: string;
  detail: string;
  context: OpsContext;
  /** Times it happened since it was last posted (including this one). */
  newCount: number;
  /** Times it happened in total. */
  totalCount: number;
  firstSeen: number;
  lastSeen: number;
  /** It was posted before: this is a follow-up with the count since. */
  repeat: boolean;
  /** Shown in the footer, to look the event up or mute it (RUNBOOKS R9). */
  fingerprint?: string;
}

/** A health problem (checked, not logged): posted when it starts and when it clears. */
export interface OpsProblemNotice {
  kind: "problem" | "resolved";
  subject: string;
  detail: string;
  since?: number;
  /** Something is down (a service, a job, alert delivery): the problem's notice carries the configured mention. */
  critical?: boolean;
}

// ---------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------

const SECRET_KEYS =
  "password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|x-api-key|authorization|auth|cookie|set-cookie|session|signature|private[_-]?key|privatekey|mnemonic|seed|hmac|kek|credential|credentials";

/** A word as recovery phrases are compared: lowercase, with accents and other marks taken off (BIP-39 uses NFKD). */
const foldWord = (w: string): string =>
  /^[A-Za-z]+$/.test(w) ? w.toLowerCase() : /^[\u4e00-\u9fff]+$/.test(w) ? w : w.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();

/**
 * BIP-39's ten word lists (English, which Ethereum and Bittensor wallets use, and the Spanish, French, Italian,
 * Portuguese, Czech, Japanese, Korean and both Chinese ones other wallets offer), each folded with {@link foldWord}.
 * A phrase's words all come from one list.
 */
const PHRASE_LISTS: readonly ReadonlySet<string>[] = [english, spanish, french, italian, portuguese, czech, japanese, korean, simplifiedChinese, traditionalChinese].map(
  (list) => new Set(list.map(foldWord)),
);
/** Both Chinese lists (bits of {@link PHRASE_LISTS}): their words are one character each. */
const CHINESE_LISTS = (1 << 8) | (1 << 9);
/** This many of those words in a row are taken for a recovery phrase (or part of one): ordinary text seldom has them. */
export const PHRASE_RUN = 6;
/**
 * The longest stretch without letters that still joins two words of a phrase: what lists put between them (`", "`,
 * `"\n12. "`, `" | "`, `"-"`, a JSON array's `",\n    "`, a table's `" | 7 | "`).
 */
const PHRASE_GAP = 16;
/**
 * Numbering a list puts before a word: `12.`, `3)`, `(4)`, `5:`, `#6`, `#7:`, full-width (`８．`, `（９）`), and a JSON
 * object's quoted key (`"10": "`).
 */
const NUMBERING = /[0-9０-９]+[.):．）：]|#[0-9]+[.):]?|\([0-9]+\)|（[0-9０-９]+）|["'][0-9]+["']\s*:/g;
/**
 * Whether the stretch between two words could be a list's: only spaces and line breaks, digits and numbering, commas,
 * semicolons, pipes, hyphens, underscores and bullets, and quotes and brackets with a comma, a line break or a quoted
 * key (JSON, a Python list). What ends or runs through a sentence (`.`, `!`, `?`, `:`, parentheses, arrows, slashes,
 * dashes, backticks, markup) never is.
 */
function listGap(gap: string): boolean {
  if (gap.length > PHRASE_GAP) return false;
  const rest = gap.replace(NUMBERING, " ");
  if (!/^[\s0-9０-９,;|_•*、，；"'[\]{}-]*$/.test(rest)) return false;
  return !/["'[\]{}]/.test(rest) || /[,\n]/.test(rest) || /["']\d+["']\s*:/.test(gap);
}
/**
 * Numbers between one-character words (the Chinese lists) join them only in a list (a line break or numbering, also
 * `1、` and full-width): "2026年11月11日" and "1分 5分 15分" are dates and timeframes.
 */
const chineseGap = (gap: string): boolean =>
  !/[0-9０-９]/.test(gap) || /\n/.test(gap) || /[0-9０-９][.):．）：]|\s[0-9０-９]+、|\([0-9]+\)|（[0-9０-９]+）|["'][0-9]+["']\s*:/.test(gap);
/** No BIP-39 word is longer (in UTF-16 units, before folding): longer runs of letters are never looked up. */
const MAX_WORD = 16;

/**
 * Hides recovery phrases: a run of at least {@link PHRASE_RUN} words of one BIP-39 list becomes `[phrase]`, also
 * inside a longer run of words. Words match in any case and with or without accents, and what lists put between words
 * may stand between them ({@link listGap}): spaces, line breaks, numbering (`1.`, `2)`), commas, semicolons, hyphens,
 * pipes, quotes and brackets (JSON); never the end of a sentence or other prose punctuation. Words written with
 * nothing between them (Chinese without spaces) aren't found. The backend's error reports (src/routes/support.ts) and
 * AI checks, and the app's error reports (src/services/errorReports.ts), use it as well as {@link scrubOpsText}.
 */
export function scrubPhrases(s: string): string {
  // Each word of a list: where it is, the lists it is in (one bit each), and the lists whose run it continues (it
  // follows a word of the list across a gap a list has). Other words only break runs.
  const words: { start: number; end: number; in: number; joins: number }[] = [];
  const folds = new Map<string, number>();
  let any = 0;
  let prevEnd = 0;
  let prevIn = 0;
  for (const m of s.matchAll(/[\p{L}\p{M}]+/gu)) {
    const w = m[0];
    let lists = 0;
    if (w.length <= MAX_WORD) {
      const known = folds.get(w);
      if (known !== undefined) lists = known;
      else {
        const folded = foldWord(w);
        for (let i = 0; i < PHRASE_LISTS.length; i++) if (PHRASE_LISTS[i]!.has(folded)) lists |= 1 << i;
        if (folds.size < 4096) folds.set(w, lists);
      }
    }
    if (lists !== 0) {
      let joins = prevIn & lists;
      if (joins !== 0) {
        const gap = s.slice(prevEnd, m.index);
        if (!listGap(gap)) joins = 0;
        else if (!chineseGap(gap)) joins &= ~CHINESE_LISTS;
      }
      words.push({ start: m.index, end: m.index + w.length, in: lists, joins });
    }
    any |= lists;
    prevEnd = m.index + w.length;
    prevIn = lists;
  }
  if (any === 0) return s;
  // Spans to hide, from each list's runs (a run may belong to two lists: the spans then overlap).
  const spans: [number, number][] = [];
  for (let list = 0; list < PHRASE_LISTS.length; list++) {
    const bit = 1 << list;
    if ((any & bit) === 0) continue;
    let first = -1;
    for (let i = 0; i <= words.length; i++) {
      const w = words[i];
      const member = w !== undefined && (w.in & bit) !== 0;
      if (member && first >= 0 && (w.joins & bit) !== 0) continue;
      if (first >= 0 && i - first >= PHRASE_RUN) spans.push([words[first]!.start, words[i - 1]!.end]);
      // A word of the list after a gap no list has starts a run of its own.
      first = member ? i : -1;
    }
  }
  if (spans.length === 0) return s;
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = -1;
  for (const [start, end] of spans) {
    if (end <= at) continue;
    // A span that starts inside the previous one only makes it longer.
    if (start > at) out += `${s.slice(Math.max(at, 0), start)}[phrase]`;
    at = end;
  }
  return out + s.slice(at);
}

/** Longest text scrubbed (callers keep far less): bounds the work on attacker-supplied text. */
const MAX_SCRUB = 8_000;

/**
 * Well-formed UTF-16: a lone surrogate (half an emoji, e.g. from a cut) becomes U+FFFD. Postgres refuses jsonb with a
 * lone surrogate, and one anonymous report must never be able to break the alert path's writes.
 */
export function wellFormed(s: string): string {
  const f = (s as { toWellFormed?: () => string }).toWellFormed;
  return typeof f === "function" ? f.call(s) : s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * Removes secrets and personal data from text that will leave the server (see the module notes). Every pattern is
 * anchored at the start of a token (a lookbehind) and bounded, so the work stays linear in the (capped) length on
 * any input: a crafted report can't stall the worker that also runs the guardians.
 */
export function scrubOpsText(input: string): string {
  let s = wellFormed(input.length > MAX_SCRUB ? input.slice(0, MAX_SCRUB) : input);
  // Control characters (not tab and newline) could hide text or break formatting; NUL also breaks Postgres text.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "");
  s = s.replace(/-----BEGIN [A-Z0-9 ]{1,40}-----[\s\S]*?(?:-----END [A-Z0-9 ]{1,40}-----|$)/g, "[pem]");
  // A webhook URL (Discord's or another) grants posting: never repeat one.
  s = s.replace(/(discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/)[^\s"'<>)]+/gi, "$1[redacted]");
  s = s.replace(/(hooks\.slack\.com\/services\/)[^\s"'<>)]+/gi, "$1[redacted]");
  // Credentials in URLs: scheme://user:password@host, also with an empty user (rediss://:password@host).
  s = s.replace(/(?<![a-z0-9+.-])([a-z][a-z0-9+.-]{0,30}:\/\/)[^\s/@:'"]*(?::[^\s/@'"]*)?@/gi, "$1[credentials]@");
  // Query strings and fragments of URLs (tokens travel there); a stack frame's line and column stay.
  s = s.replace(/(\bhttps?:\/\/[^\s?#)"'<>]*)[?#][^\s)"'<>]*?(?=(?::\d+:\d+)?(?:[)\s"'<>]|$))/gi, "$1");
  // …and of paths (`/v1/x?token=…`).
  s = s.replace(/(^|[\s("'])(\/[\w./~%-]*)[?#][^\s)"']*/g, "$1$2");
  s = s.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  // `password=…`, `"secret":"…"`, and environment names ending in one (`HMAC_SECRET=`, `OPENROUTER_API_KEY=`).
  s = s.replace(
    new RegExp(`(?<![A-Za-z0-9])((?:[A-Za-z0-9]{1,40}_){0,4}(?:${SECRET_KEYS}))(\\s*[=:]\\s*|"\\s*:\\s*"?|'\\s*:\\s*'?)([^\\s,;&"'}\\]]+)`, "gi"),
    "$1$2[redacted]",
  );
  // …and a quoted secret's whole value (`"mnemonic":"word word …"`), which the rule above cuts at the first space.
  s = s.replace(new RegExp(`("(?:${SECRET_KEYS})"\\s*:\\s*)"(?:[^"\\\\]|\\\\.){0,2000}"`, "gi"), '$1"[redacted]"');
  // Recovery phrases after the key rules: a key's name made of list words (`…_WAVE_TOKEN=`) must still hide its value.
  s = scrubPhrases(s);
  s = s.replace(/(?<![A-Za-z0-9_-])sk-(?:ant-)?[A-Za-z0-9_-]{16,256}/g, "sk-[redacted]");
  s = s.replace(/(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{30,128}/g, "AIza[redacted]");
  s = s.replace(/(?<![A-Za-z0-9_-])xox[abprs]-[A-Za-z0-9-]{10,256}/g, "xox-[redacted]");
  s = s.replace(/(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{20,256}/g, "gh_[redacted]");
  s = s.replace(/(?<![A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/g, "[aws-key]");
  // AWS account ids in ARNs (they name the account an attacker would aim at).
  s = s.replace(/(arn:aws[a-z-]{0,20}:[a-z0-9-]{1,40}:[a-z0-9-]{0,40}:)\d{12}(?=:)/g, "$1[account]");
  // Telegram bot tokens, also inside a path (`/bot<token>/`).
  s = s.replace(/(?<!\d)\d{6,12}:[A-Za-z0-9_-]{30,64}(?![A-Za-z0-9_-])/g, "[telegram-token]");
  s = s.replace(/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,1024}\.[A-Za-z0-9_-]{8,4096}\.[A-Za-z0-9_-]{8,1024}/g, "[jwt]");
  // Keys, signatures, hashes, then addresses (40 hex) and anything else long in hex or base64(url).
  s = s.replace(/0x[0-9a-fA-F]{41,}/g, "0x[hex]");
  s = s.replace(/(?<![0-9A-Za-z])(?=([0-9a-fA-F]{64,}))\1(?![0-9A-Za-z])/g, "[hex]");
  s = s.replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "0x[address]");
  const mixed = (m: string) => /\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m);
  s = s.replace(/[A-Za-z0-9+/]{48,}={0,2}/g, (m) => (mixed(m) ? "[base64]" : m));
  // Session tokens, random ids and keys in base64url (43 characters for 32 bytes).
  s = s.replace(/(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g, (m) => (mixed(m) ? "[token]" : m));
  s = s.replace(/(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![\w-])/g, "[email]");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]");
  s = s.replace(/\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g, "[ip]");
  return s;
}

/** Cuts to `max` characters (with "…"), never between the two halves of an emoji. */
const cut = (s: string, max: number) => {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end--;
  return `${s.slice(0, end)}…`;
};

/**
 * Up to `max` frames of an error's stack ("at fn (file:line:col)"), paths shortened to the app's own files and
 * dependencies (no absolute paths of the machine). Empty when the stack has no frames.
 */
export function stackFrames(err: unknown, max = 5): string[] {
  const stack = err instanceof Error && typeof err.stack === "string" ? err.stack : "";
  return stack
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("at "))
    .slice(0, max)
    .map((l) =>
      cut(
        l
          .replace(/file:\/\//g, "")
          .replace(/\/(?:[^\s/():]+\/)*node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?/g, "~/")
          .replace(/\/(?:[^\s/():]+\/)*?(dist|src)\//g, "$1/"),
        200,
      ),
    );
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

/** Takes the variable parts out of a text so repeats of one error group together. */
export function normalizeForFingerprint(s: string): string {
  return s
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "[uuid]")
    .replace(/0x[0-9a-fA-F]+/g, "0x#")
    .replace(/\b[0-9a-fA-F]{8,}\b/g, "#")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/** FNV-1a (64-bit) as hex: stable, dependency-free, fine for grouping (not for security). */
function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    h ^= BigInt(byte);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/**
 * Groups an event: its source, title, the detail's first line and first stack frame, with numbers, ids and hex taken
 * out. The same bug reported with different users, amounts or ids is one alert.
 */
export function opsFingerprint(e: Pick<OpsEvent, "source" | "title" | "detail" | "fingerprint">): string {
  if (e.fingerprint) return e.fingerprint;
  const lines = (e.detail ?? "").split("\n");
  const frame = lines.find((l) => l.trim().startsWith("at ")) ?? "";
  return fnv1a64([e.source, normalizeForFingerprint(e.title), normalizeForFingerprint(lines[0] ?? ""), normalizeForFingerprint(frame)].join("\n"));
}

/** An event cleaned and cut to size (every text scrubbed; context limited to 12 short values). */
export function cleanOpsEvent(e: OpsEvent): Required<Omit<OpsEvent, "fingerprint">> & { fingerprint: string } {
  const context: OpsContext = {};
  for (const [k, v] of Object.entries(e.context ?? {}).slice(0, 12)) {
    if (!/^[A-Za-z][\w.-]{0,40}$/.test(k)) continue;
    context[k] = typeof v === "string" ? cut(scrubOpsText(v), 120) : typeof v === "number" || typeof v === "boolean" || v === null ? v : null;
  }
  const clean = {
    severity: e.severity,
    source: cut(scrubOpsText(e.source), 40),
    title: cut(scrubOpsText(e.title).replace(/\s+/g, " ").trim() || "(no message)", 200),
    detail: cut(scrubOpsText(e.detail ?? ""), 1500),
    context,
  };
  return { ...clean, fingerprint: e.fingerprint ?? opsFingerprint(clean) };
}

/**
 * In-memory grouping of events between flushes (per process): each fingerprint once, with a count; at most
 * `maxDistinct` fingerprints, beyond which events are counted into one overflow alert (a flood of distinct errors
 * never grows memory or the batch).
 */
export class OpsAggregator {
  private readonly items = new Map<string, { event: ReturnType<typeof cleanOpsEvent>; count: number; first: number; last: number }>();
  private overflow = 0;
  private overflowFirst = 0;
  constructor(
    private readonly source: string,
    private readonly maxDistinct = 200,
  ) {}

  add(e: OpsEvent, now: number): void {
    const event = cleanOpsEvent(e);
    const cur = this.items.get(event.fingerprint);
    if (cur) {
      cur.count++;
      cur.last = now;
      // Keep the worst severity and the latest detail.
      if (OPS_SEVERITY_RANK[event.severity] > OPS_SEVERITY_RANK[cur.event.severity]) cur.event = { ...cur.event, severity: event.severity };
      cur.event = { ...cur.event, detail: event.detail, context: event.context };
      return;
    }
    if (this.items.size >= this.maxDistinct) {
      if (this.overflow === 0) this.overflowFirst = now;
      this.overflow++;
      return;
    }
    this.items.set(event.fingerprint, { event, count: 1, first: now, last: now });
  }

  get size(): number {
    return this.items.size + (this.overflow > 0 ? 1 : 0);
  }

  /** Everything grouped since the last drain (the overflow as one warning), and empties the buffer. */
  drain(): Array<{ event: ReturnType<typeof cleanOpsEvent>; count: number; first: number; last: number }> {
    const out = [...this.items.values()];
    if (this.overflow > 0) {
      const event = cleanOpsEvent({
        severity: "error",
        source: this.source,
        title: "Too many different errors at once",
        detail: `${this.overflow} more events of other kinds were counted but not kept (more than ${this.maxDistinct} kinds between two flushes). Check the logs.`,
        fingerprint: `overflow:${this.source}`,
      });
      out.push({ event, count: this.overflow, first: this.overflowFirst, last: this.overflowFirst });
    }
    this.items.clear();
    this.overflow = 0;
    return out;
  }

  /** Puts drained items back (a flush that failed), merging with what arrived meanwhile. */
  restore(items: ReturnType<OpsAggregator["drain"]>): void {
    for (const it of items) {
      const cur = this.items.get(it.event.fingerprint);
      if (cur) {
        cur.count += it.count;
        cur.first = Math.min(cur.first, it.first);
      } else if (this.items.size < this.maxDistinct) this.items.set(it.event.fingerprint, { ...it });
      else this.overflow += it.count;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

export type OpsWebhookKind = "discord" | "slack";

const DISCORD_HOSTS = new Set(["discord.com", "discordapp.com", "canary.discord.com", "ptb.discord.com"]);

/**
 * What a webhook URL is, or why it can't be used. Discord's own URLs (`https://discord.com/api/webhooks/<id>/<token>`)
 * get Discord messages; its `/slack` form and any other https URL get Slack-compatible `{"text"}`. Plain http only for
 * this machine (tests). Never includes the URL in its message.
 */
export function opsWebhookKind(url: string): { kind: OpsWebhookKind } | { problem: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { problem: "is not a URL" };
  }
  const local = u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol !== "https:" && !local) return { problem: "must use https" };
  if (u.username || u.password) return { problem: "must not contain credentials" };
  if (DISCORD_HOSTS.has(u.hostname)) {
    const m = /^\/api(?:\/v\d+)?\/webhooks\/\d{15,21}\/[\w-]{20,100}(\/slack|\/github)?\/?$/.exec(u.pathname);
    if (!m) return { problem: "is not a Discord webhook URL (https://discord.com/api/webhooks/<id>/<token>)" };
    if (m[1] === "/github") return { problem: "must not use Discord's /github form" };
    return { kind: m[1] === "/slack" ? "slack" : "discord" };
  }
  return { kind: "slack" };
}

/** Who critical alerts ping on Discord: users and roles by id (never @everyone or @here). */
export interface DiscordMention {
  users: string[];
  roles: string[];
}

/** At most this many mentions in OPS_ALERT_DISCORD_MENTION. */
export const MAX_DISCORD_MENTIONS = 10;

/**
 * OPS_ALERT_DISCORD_MENTION: one or more users `<@123…>` and roles `<@&123…>`, separated by spaces or commas, for
 * example `<@111…> <@222…>`. Anything else (and more than {@link MAX_DISCORD_MENTIONS}) is refused as a whole.
 */
export function parseDiscordMention(value: string | undefined): DiscordMention | null {
  const parts = (value ?? "").split(/[\s,]+/).filter((p) => p !== "");
  if (parts.length === 0 || parts.length > MAX_DISCORD_MENTIONS) return null;
  const users = new Set<string>();
  const roles = new Set<string>();
  for (const p of parts) {
    const user = /^<@!?(\d{15,21})>$/.exec(p);
    const role = /^<@&(\d{15,21})>$/.exec(p);
    if (user) users.add(user[1]!);
    else if (role) roles.add(role[1]!);
    else return null;
  }
  return { users: [...users], roles: [...roles] };
}

/** The message text that pings {@link DiscordMention}'s users and roles. */
export function discordMentionText(m: DiscordMention): string {
  return [...m.users.map((u) => `<@${u}>`), ...m.roles.map((r) => `<@&${r}>`)].join(" ");
}

const EMOJI: Readonly<Record<OpsSeverity, string>> = { critical: "🔴", error: "🟠", warning: "🟡" };
const COLOR: Readonly<Record<OpsSeverity | "resolved" | "info", number>> = {
  critical: 0xe5484d,
  error: 0xf76b15,
  warning: 0xffc53d,
  resolved: 0x30a46c,
  info: 0x0090ff,
};

/** Inside a code block nothing renders; backticks are swapped so the text can't close the block. */
const codeBlock = (s: string, max: number) => "```\n" + cut(s.replace(/`/g, "ˋ"), max - 8) + "\n```";
const inlineCode = (s: string, max: number) => "`" + cut(s.replace(/`/g, "ˋ").replace(/\n/g, " "), max - 2) + "`";
/** Text outside code blocks: no mention (`@`, `<@…>`), no masked link (`[text](url)`), no code span. */
const plain = (s: string, max: number) => cut(s.replace(/[@<>[\]`]/g, (c) => ({ "@": "＠", "<": "‹", ">": "›", "[": "［", "]": "］", "`": "ˋ" })[c] ?? c), max);
const unix = (ms: number) => Math.floor(ms / 1000);

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields?: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

export interface DiscordPayload {
  content?: string;
  username: string;
  embeds: DiscordEmbed[];
  allowed_mentions: { parse: []; users?: string[]; roles?: string[] };
}

function embedSize(e: DiscordEmbed): number {
  return e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((n, f) => n + f.name.length + f.value.length, 0);
}

/** Every text of an alert cleaned again at the last step: nothing leaves unscrubbed, whatever path built it. */
function scrubAlert(a: OpsAlert): OpsAlert {
  const context: OpsContext = {};
  for (const [k, v] of Object.entries(a.context)) context[k] = typeof v === "string" ? scrubOpsText(v) : v;
  return { ...a, source: scrubOpsText(a.source), title: scrubOpsText(a.title), detail: scrubOpsText(a.detail), context };
}
const scrubNotice = (p: OpsProblemNotice): OpsProblemNotice => ({ ...p, subject: scrubOpsText(p.subject), detail: scrubOpsText(p.detail) });

function alertEmbed(raw: OpsAlert, label: string): DiscordEmbed {
  const a = scrubAlert(raw);
  const fields: DiscordEmbed["fields"] = [
    { name: "Where", value: plain(a.source, 100), inline: true },
    {
      name: "Seen",
      value: a.repeat
        ? `×${a.newCount} more since the last message (${a.totalCount} in all, first <t:${unix(a.firstSeen)}:R>)`
        : a.newCount > 1
          ? `×${a.newCount}, first <t:${unix(a.firstSeen)}:R>`
          : `first time, <t:${unix(a.firstSeen)}:R>`,
      inline: true,
    },
  ];
  const ctx = Object.entries(a.context)
    .map(([k, v]) => `${plain(k, 40)}: ${inlineCode(String(v), 110)}`)
    .join("\n");
  if (ctx) fields.push({ name: "Context", value: cut(ctx, 1000), inline: false });
  return {
    title: cut(`${EMOJI[a.severity]} ${a.severity.toUpperCase()}${a.repeat ? " (again)" : ""} · ${plain(a.title, 200)}`, 256),
    ...(a.detail ? { description: codeBlock(a.detail, 1600) } : {}),
    color: COLOR[a.severity],
    fields,
    footer: { text: cut(a.fingerprint ? `${label} · id ${a.fingerprint}` : label, 200) },
    timestamp: new Date(a.lastSeen).toISOString(),
  };
}

function problemEmbed(raw: OpsProblemNotice, label: string): DiscordEmbed {
  const p = scrubNotice(raw);
  const resolved = p.kind === "resolved";
  const critical = !resolved && p.critical === true;
  return {
    title: cut(`${resolved ? "✅ Resolved" : critical ? "🔴 Problem" : "⚠️ Problem"} · ${plain(p.subject, 200)}`, 256),
    description: codeBlock(p.detail, 1200),
    color: resolved ? COLOR.resolved : critical ? COLOR.critical : COLOR.error,
    ...(p.since ? { fields: [{ name: resolved ? "Lasted since" : "Since", value: `<t:${unix(p.since)}:R>`, inline: true }] } : {}),
    footer: { text: cut(label, 200) },
  };
}

export interface OpsBatch {
  alerts?: OpsAlert[];
  problems?: OpsProblemNotice[];
  note?: string;
}

/** One message of a batch and what it carries (indices into the batch's alerts and problems). */
interface OpsMessage<P> {
  payload: P;
  alerts: number[];
  problems: number[];
  note: boolean;
}

/** An alert or problem that should ping: a critical alert, or a critical problem starting. */
const pings = (x: { alert?: OpsAlert; problem?: OpsProblemNotice }) =>
  x.alert ? x.alert.severity === "critical" : x.problem?.kind === "problem" && x.problem.critical === true;

function discordMessages(batch: OpsBatch, o: { label: string; mention?: DiscordMention | null }): Array<OpsMessage<DiscordPayload>> {
  type Item = { embed: DiscordEmbed; alert?: number; problem?: number; note?: true; ping: boolean };
  const items: Item[] = [
    ...(batch.problems ?? []).map((p, i): Item => ({ embed: problemEmbed(p, o.label), problem: i, ping: pings({ problem: p }) })),
    ...(batch.alerts ?? []).map((a, i): Item => ({ embed: alertEmbed(a, o.label), alert: i, ping: pings({ alert: a }) })),
  ];
  if (batch.note) {
    items.push({ embed: { title: "More", description: codeBlock(scrubOpsText(batch.note), 1500), color: COLOR.info, footer: { text: cut(o.label, 200) } }, note: true, ping: false });
  }
  const out: Array<OpsMessage<DiscordPayload>> = [];
  let cur: Item[] = [];
  let size = 0;
  let mentioned = false;
  const push = () => {
    if (cur.length === 0) return;
    // The mention goes with the first message that holds something critical, once per batch.
    const mention = !mentioned && cur.some((i) => i.ping) ? o.mention : null;
    if (mention) mentioned = true;
    out.push({
      payload: {
        ...(mention ? { content: discordMentionText(mention) } : {}),
        username: "Kokoah alerts",
        embeds: cur.map((i) => i.embed),
        allowed_mentions: {
          parse: [],
          ...(mention && mention.users.length > 0 ? { users: mention.users } : {}),
          ...(mention && mention.roles.length > 0 ? { roles: mention.roles } : {}),
        },
      },
      alerts: cur.flatMap((i) => (i.alert === undefined ? [] : [i.alert])),
      problems: cur.flatMap((i) => (i.problem === undefined ? [] : [i.problem])),
      note: cur.some((i) => i.note),
    });
    cur = [];
    size = 0;
  };
  for (const i of items) {
    const n = embedSize(i.embed);
    if (cur.length === 10 || size + n > 5800) push();
    cur.push(i);
    size += n;
  }
  push();
  return out;
}

/**
 * Discord messages for a batch: one embed per alert or problem, split so each message holds at most 10 embeds and
 * 6000 characters. The first message holding a critical alert or a critical problem adds the configured mention in
 * `content` (and only that one may ping).
 */
export function discordPayloads(batch: OpsBatch, o: { label: string; mention?: DiscordMention | null }): DiscordPayload[] {
  return discordMessages(batch, o).map((m) => m.payload);
}

/**
 * Text for a Slack-compatible message: `&`, `<` and `>` escaped (no `<!channel>`, `<url|text>` or `<@user>`), `@` and
 * square brackets neutralised (no `@here` or `[text](url)` where the receiver renders them).
 */
const slackText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/@/g, "＠").replace(/\[/g, "［").replace(/\]/g, "］");

function slackMessages(raw: OpsBatch, o: { label: string }): Array<OpsMessage<{ text: string }>> {
  const batch = { ...raw, alerts: (raw.alerts ?? []).map(scrubAlert), problems: (raw.problems ?? []).map(scrubNotice), ...(raw.note ? { note: scrubOpsText(raw.note) } : {}) };
  const lines: Array<{ text: string; alert?: number; problem?: number; note?: true }> = [];
  for (const [i, p] of batch.problems.entries()) {
    const head = p.kind === "resolved" ? "✓ resolved" : p.critical ? "🔴 problem" : "⚠ problem";
    lines.push({ text: `${head} · ${slackText(p.subject)}: ${slackText(cut(p.detail, 300))}`, problem: i });
  }
  for (const [i, a] of batch.alerts.entries()) {
    const seen = a.repeat ? `×${a.newCount} more (${a.totalCount} in all)` : a.newCount > 1 ? `×${a.newCount}` : "first time";
    const ctx = Object.entries(a.context)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    lines.push({
      text: `${EMOJI[a.severity]} ${a.severity.toUpperCase()} · ${slackText(a.source)}: ${slackText(a.title)} (${seen})${a.detail ? `\n    ${slackText(cut(a.detail.split("\n")[0] ?? "", 300))}` : ""}${ctx ? `\n    ${slackText(cut(ctx, 300))}` : ""}`,
      alert: i,
    });
  }
  if (batch.note) lines.push({ text: slackText(batch.note), note: true });
  const out: Array<OpsMessage<{ text: string }>> = [];
  let cur: OpsMessage<{ text: string }> = { payload: { text: `Kokoah ${o.label}:` }, alerts: [], problems: [], note: false };
  for (const l of lines) {
    if (cur.payload.text.length + l.text.length + 1 > 3500) {
      out.push(cur);
      cur = { payload: { text: `Kokoah ${o.label} (continued):` }, alerts: [], problems: [], note: false };
    }
    cur.payload.text += `\n${l.text}`;
    if (l.alert !== undefined) cur.alerts.push(l.alert);
    if (l.problem !== undefined) cur.problems.push(l.problem);
    if (l.note) cur.note = true;
  }
  if (lines.length > 0) out.push(cur);
  return out;
}

/** Slack-compatible `{"text"}` messages (Slack, Mattermost, Google Chat, ntfy, Discord's /slack): one per 3,500 characters. */
export function slackPayloads(batch: OpsBatch, o: { label: string }): Array<{ text: string }> {
  return slackMessages(batch, o).map((m) => m.payload);
}

export type OpsPostResult =
  /** `waitMs`: Discord's bucket is empty; the next post should wait this long. */
  | { ok: true; waitMs?: number }
  /** Wait this long before posting again (HTTP 429 or the bucket is empty). */
  | { ok: false; retryAfterMs: number }
  /** The webhook no longer accepts posts (deleted, wrong token): 401, 403, 404. */
  | { ok: false; rejected: number }
  /** The receiver refused this message (400, 413): posting it again won't help. */
  | { ok: false; badPayload: number; reason: string }
  /** Unreachable or a server error: try again later. */
  | { ok: false; failed: string };

/** Posts one payload. Never throws and never puts the URL in its result. */
export async function postOpsWebhook(url: string, payload: unknown, fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<OpsPostResult> {
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, failed: err instanceof Error ? (err.name === "TimeoutError" ? "timed out" : `unreachable (${err.name})`) : "unreachable" };
  }
  const text = await res.text().catch(() => "");
  if (res.ok) {
    // Discord: out of requests in this bucket; the next post would get 429.
    const reset = Number(res.headers.get("x-ratelimit-reset-after"));
    return res.headers.get("x-ratelimit-remaining") === "0" && reset > 0 ? { ok: true, waitMs: Math.min(reset * 1000, 60_000) } : { ok: true };
  }
  if (res.status === 429) {
    let wait = Number(res.headers.get("retry-after"));
    try {
      const body = JSON.parse(text) as { retry_after?: unknown };
      if (typeof body.retry_after === "number") wait = body.retry_after;
    } catch {
      /* the header then */
    }
    return { ok: false, retryAfterMs: Math.min(Math.max(Number.isFinite(wait) && wait > 0 ? wait * 1000 : 5_000, 1_000), 600_000) };
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, rejected: res.status };
  if (res.status === 400 || res.status === 413) {
    let reason = "";
    try {
      const body = JSON.parse(text) as { message?: unknown; code?: unknown };
      reason = [typeof body.code === "number" ? String(body.code) : "", typeof body.message === "string" ? body.message : ""].filter(Boolean).join(" ");
    } catch {
      reason = text.slice(0, 120);
    }
    return { ok: false, badPayload: res.status, reason: cut(scrubOpsText(reason), 200) };
  }
  return { ok: false, failed: `HTTP ${res.status}` };
}

/**
 * What a batch post delivered: the messages that went out, and the alerts, problems (indices into the batch) and note
 * they carried. A message the receiver refused even in plain form counts as delivered: posting it again won't help.
 */
export interface OpsBatchSent {
  messages: number;
  alerts: number[];
  problems: number[];
  note: boolean;
}

export type OpsBatchResult = OpsPostResult & { sent: OpsBatchSent };

/**
 * Posts a batch in as many messages as it needs, in order, stopping at the first failure; `sent` says what went out
 * before it, so the caller marks exactly that and keeps the rest (a 429 halfway never posts the earlier messages, or
 * their mention, again). A message the receiver refuses as malformed is replaced once by a short plain notice listing
 * its titles, so an alert is never lost to a formatting problem.
 */
export async function sendOpsBatch(
  url: string,
  batch: OpsBatch,
  o: { label: string; mention?: DiscordMention | null; fetchFn?: typeof fetch },
): Promise<OpsBatchResult> {
  const sent: OpsBatchSent = { messages: 0, alerts: [], problems: [], note: false };
  const kind = opsWebhookKind(url);
  if ("problem" in kind) return { ok: false, rejected: 0, sent };
  const messages: Array<OpsMessage<unknown>> = kind.kind === "discord" ? discordMessages(batch, o) : slackMessages(batch, o);
  const carried = (m: OpsMessage<unknown>) => {
    sent.alerts.push(...m.alerts);
    sent.problems.push(...m.problems);
    sent.note ||= m.note;
  };
  let wait = 0;
  for (const m of messages) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    let r = await postOpsWebhook(url, m.payload, o.fetchFn);
    if (!r.ok && "badPayload" in r) {
      const titles = [
        ...m.problems.map((i) => batch.problems![i]!.subject),
        ...m.alerts.map((i) => `${batch.alerts![i]!.severity}: ${batch.alerts![i]!.title}`),
        ...(m.note ? ["(a note with more events)"] : []),
      ];
      const text = cut(`Kokoah ${o.label}: ${titles.length} alert(s) could not be formatted (${r.reason}):\n- ${titles.map((t) => plain(scrubOpsText(t), 150)).join("\n- ")}`, 1900);
      const retry = await postOpsWebhook(url, kind.kind === "discord" ? { content: text, username: "Kokoah alerts", allowed_mentions: { parse: [] } } : { text }, o.fetchFn);
      if (retry.ok || "badPayload" in retry) {
        // Posted in plain form, or refused in that form too: either way this message is done with.
        carried(m);
        if (retry.ok) sent.messages++;
      }
      r = retry;
    } else if (r.ok) {
      carried(m);
      sent.messages++;
    }
    if (!r.ok) return { ...r, sent };
    wait = r.waitMs ?? 0;
  }
  return { ok: true, sent };
}
