/**
 * Operator alerts shared by the backend and the signer service: what an alert is, how its text is cleaned before it
 * leaves the server, how repeats are grouped, and how a batch is posted to a Discord webhook (or a Slack-compatible
 * one) within the receiver's limits.
 *
 * - **Nothing secret or personal leaves.** {@link scrubOpsText} removes credentials in URLs, query strings, bearer
 *   tokens, `key=value` secrets, known API-key and token formats (OpenAI/Anthropic `sk-`, Google `AIza`, Slack, GitHub,
 *   Telegram bot tokens, JWTs, Discord webhook URLs), PEM blocks, private keys, signatures and long hex or base64,
 *   wallet addresses, e-mail and IP addresses, and control characters. Alerts go to a third party (Discord).
 * - **One bug, one message.** {@link opsFingerprint} groups an error by where it happened and its message with the
 *   variable parts (numbers, ids, hex) taken out; repeats are counted and reported after a cooldown by severity
 *   ({@link OPS_COOLDOWN_MS}), never one message each.
 * - **Untrusted text can't ping or link.** Messages carry text from errors and from browsers' reports: it goes into
 *   code blocks with backticks neutralised, and `allowed_mentions` is empty except for the one configured mention on
 *   critical alerts.
 * - **Within Discord's limits.** Title 256, description 4096, field 1024, footer 2048, 6000 characters and 10 embeds per
 *   message, 2000 for `content`; batches are split to fit. 429 answers carry the wait ({@link postOpsWebhook}).
 */

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
}

/** A health problem (checked, not logged): posted when it starts and when it clears. */
export interface OpsProblemNotice {
  kind: "problem" | "resolved";
  subject: string;
  detail: string;
  since?: number;
}

// ---------------------------------------------------------------------------------------------
// Cleaning
// ---------------------------------------------------------------------------------------------

const SECRET_KEYS =
  "password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|id_token|api[_-]?key|apikey|x-api-key|authorization|auth|cookie|set-cookie|session|signature|private[_-]?key|privatekey|mnemonic|seed|hmac|kek|credential|credentials";

/** Removes secrets and personal data from text that will leave the server (see the module notes). */
export function scrubOpsText(input: string): string {
  let s = input;
  // Control characters (not tab and newline) could hide text or break formatting.
  s = s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁦-⁩]/g, "");
  s = s.replace(/-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g, "[pem]");
  // A webhook URL (Discord's or another) grants posting: never repeat one.
  s = s.replace(/(discord(?:app)?\.com\/api\/webhooks\/)[^\s"'<>)]+/gi, "$1[redacted]");
  s = s.replace(/(hooks\.slack\.com\/services\/)[^\s"'<>)]+/gi, "$1[redacted]");
  // Credentials in URLs: scheme://user:password@host.
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:'"]+(?::[^\s/@'"]*)?@/gi, "$1[credentials]@");
  // Query strings and fragments of URLs (tokens travel there); a stack frame's line and column stay.
  s = s.replace(/(\bhttps?:\/\/[^\s?#)"'<>]*)[?#][^\s)"'<>]*?(?=(?::\d+:\d+)?(?:[)\s"'<>]|$))/gi, "$1");
  // …and of paths (`/v1/x?token=…`).
  s = s.replace(/(^|[\s("'])(\/[\w./~%-]*)[?#][^\s)"']*/g, "$1$2");
  s = s.replace(/\b(bearer|basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]");
  s = s.replace(new RegExp(`\\b(${SECRET_KEYS})(\\s*[=:]\\s*|"\\s*:\\s*"?|'\\s*:\\s*'?)([^\\s,;&"'}\\]]+)`, "gi"), "$1$2[redacted]");
  s = s.replace(/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/g, "sk-[redacted]");
  s = s.replace(/\bAIza[0-9A-Za-z_-]{30,}/g, "AIza[redacted]");
  s = s.replace(/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "xox-[redacted]");
  s = s.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh_[redacted]");
  s = s.replace(/\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, "[telegram-token]");
  s = s.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[jwt]");
  // Keys, signatures, hashes, then addresses (40 hex) and anything else long in hex or base64.
  s = s.replace(/0x[0-9a-fA-F]{41,}/g, "0x[hex]");
  s = s.replace(/\b[0-9a-fA-F]{64,}\b/g, "[hex]");
  s = s.replace(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g, "0x[address]");
  s = s.replace(/[A-Za-z0-9+/]{48,}={0,2}/g, (m) => (/\d/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? "[base64]" : m));
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g, "[email]");
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]");
  s = s.replace(/\b(?:[0-9a-fA-F]{1,4}:){4,7}[0-9a-fA-F]{1,4}\b/g, "[ip]");
  return s;
}

const cut = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`);

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

/** A Discord mention for critical alerts: a user `<@123…>` or a role `<@&123…>` (never @everyone or @here). */
export function parseDiscordMention(value: string | undefined): { user: string } | { role: string } | null {
  const v = value?.trim();
  if (!v) return null;
  const user = /^<@!?(\d{15,21})>$/.exec(v);
  if (user) return { user: user[1]! };
  const role = /^<@&(\d{15,21})>$/.exec(v);
  if (role) return { role: role[1]! };
  return null;
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

function alertEmbed(a: OpsAlert, label: string): DiscordEmbed {
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
    footer: { text: cut(label, 200) },
    timestamp: new Date(a.lastSeen).toISOString(),
  };
}

function problemEmbed(p: OpsProblemNotice, label: string): DiscordEmbed {
  const resolved = p.kind === "resolved";
  return {
    title: cut(`${resolved ? "✅ Resolved" : "⚠️ Problem"} · ${plain(p.subject, 200)}`, 256),
    description: codeBlock(p.detail, 1200),
    color: resolved ? COLOR.resolved : COLOR.error,
    ...(p.since ? { fields: [{ name: resolved ? "Lasted since" : "Since", value: `<t:${unix(p.since)}:R>`, inline: true }] } : {}),
    footer: { text: cut(label, 200) },
  };
}

/**
 * Discord messages for a batch: one embed per alert or problem, split so each message holds at most 10 embeds and
 * 6000 characters. A critical alert adds the configured mention in `content` (and only that one may ping).
 */
export function discordPayloads(
  batch: { alerts?: OpsAlert[]; problems?: OpsProblemNotice[]; note?: string },
  o: { label: string; mention?: { user: string } | { role: string } | null },
): DiscordPayload[] {
  const embeds = [...(batch.problems ?? []).map((p) => problemEmbed(p, o.label)), ...(batch.alerts ?? []).map((a) => alertEmbed(a, o.label))];
  if (batch.note) embeds.push({ title: "More", description: codeBlock(batch.note, 1500), color: COLOR.info, footer: { text: cut(o.label, 200) } });
  const critical = (batch.alerts ?? []).some((a) => a.severity === "critical");
  const out: DiscordPayload[] = [];
  let cur: DiscordEmbed[] = [];
  let size = 0;
  const push = () => {
    if (cur.length === 0) return;
    const mention = critical && out.length === 0 ? o.mention : null;
    out.push({
      ...(mention ? { content: "user" in mention ? `<@${mention.user}>` : `<@&${mention.role}>` } : {}),
      username: "Kokoah alerts",
      embeds: cur,
      allowed_mentions: { parse: [], ...(mention ? ("user" in mention ? { users: [mention.user] } : { roles: [mention.role] }) : {}) },
    });
    cur = [];
    size = 0;
  };
  for (const e of embeds) {
    const n = embedSize(e);
    if (cur.length === 10 || size + n > 5800) push();
    cur.push(e);
    size += n;
  }
  push();
  return out;
}

/** Slack-compatible `{"text"}` messages (Slack, Mattermost, Google Chat, ntfy, Discord's /slack): one per 3,500 characters. */
export function slackPayloads(batch: { alerts?: OpsAlert[]; problems?: OpsProblemNotice[]; note?: string }, o: { label: string }): Array<{ text: string }> {
  const lines: string[] = [];
  for (const p of batch.problems ?? []) lines.push(`${p.kind === "resolved" ? "✓ resolved" : "⚠ problem"} · ${p.subject}: ${cut(p.detail, 300)}`);
  for (const a of batch.alerts ?? []) {
    const seen = a.repeat ? `×${a.newCount} more (${a.totalCount} in all)` : a.newCount > 1 ? `×${a.newCount}` : "first time";
    const ctx = Object.entries(a.context)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join(" ");
    lines.push(`${EMOJI[a.severity]} ${a.severity.toUpperCase()} · ${a.source}: ${a.title} (${seen})${a.detail ? `\n    ${cut(a.detail.split("\n")[0] ?? "", 300)}` : ""}${ctx ? `\n    ${cut(ctx, 300)}` : ""}`);
  }
  if (batch.note) lines.push(batch.note);
  const out: Array<{ text: string }> = [];
  let text = `Kokoah ${o.label}:`;
  for (const l of lines) {
    if (text.length + l.length + 1 > 3500) {
      out.push({ text });
      text = `Kokoah ${o.label} (continued):`;
    }
    text += `\n${l}`;
  }
  if (lines.length > 0) out.push({ text });
  return out;
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
 * Posts a batch in as many messages as it needs, in order, stopping at the first failure (the caller keeps what wasn't
 * sent). A message the receiver refuses as malformed is replaced once by a short plain notice listing the titles, so
 * an alert is never lost to a formatting problem.
 */
export async function sendOpsBatch(
  url: string,
  batch: { alerts?: OpsAlert[]; problems?: OpsProblemNotice[]; note?: string },
  o: { label: string; mention?: { user: string } | { role: string } | null; fetchFn?: typeof fetch },
): Promise<OpsPostResult> {
  const kind = opsWebhookKind(url);
  if ("problem" in kind) return { ok: false, rejected: 0 };
  const payloads: unknown[] = kind.kind === "discord" ? discordPayloads(batch, o) : slackPayloads(batch, o);
  let wait = 0;
  for (const payload of payloads) {
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    let r = await postOpsWebhook(url, payload, o.fetchFn);
    if (!r.ok && "badPayload" in r) {
      const titles = [...(batch.problems ?? []).map((p) => p.subject), ...(batch.alerts ?? []).map((a) => `${a.severity}: ${a.title}`)];
      const text = cut(`Kokoah ${o.label}: ${titles.length} alert(s) could not be formatted (${r.reason}):\n- ${titles.map((t) => plain(t, 150)).join("\n- ")}`, 1900);
      r = await postOpsWebhook(url, kind.kind === "discord" ? { content: text, username: "Kokoah alerts", allowed_mentions: { parse: [] } } : { text }, o.fetchFn);
    }
    if (!r.ok) return r;
    wait = r.waitMs ?? 0;
  }
  return { ok: true };
}
