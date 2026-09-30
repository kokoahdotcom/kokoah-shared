import { describe, expect, it } from "vitest";
import {
  OpsAggregator,
  cleanOpsEvent,
  discordPayloads,
  opsFingerprint,
  opsWebhookKind,
  parseDiscordMention,
  postOpsWebhook,
  scrubOpsText,
  sendOpsBatch,
  slackPayloads,
  stackFrames,
  wellFormed,
  type DiscordPayload,
  type OpsAlert,
} from "../src/ops/index.js";

const ADDRESS = "0xAbCdEf0123456789abcdef0123456789ABCDEF01";
const DISCORD = "https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH";

describe("scrubOpsText", () => {
  it("removes secrets", () => {
    const cases: Array<[string, string]> = [
      ["connect postgres://kokoah:hunter2@db.internal:5432/kokoah", "connect postgres://[credentials]@db.internal:5432/kokoah"],
      ["GET https://api.example.com/x?token=abc&y=1 failed", "GET https://api.example.com/x failed"],
      ["at f (https://app.kokoah.test/assets/a.js?v=1:12:34)", "at f (https://app.kokoah.test/assets/a.js:12:34)"],
      ["Authorization: Bearer abcdefghijklmnop", "Authorization: [redacted] [redacted]"],
      ['{"password":"hunter2","user":"x"}', '{"password":"[redacted]","user":"x"}'],
      ["api_key=abc123def secret: s3cr3t", "api_key=[redacted] secret: [redacted]"],
      ["key sk-ant-api03-abcdefghijklmnopqrstuv used", "key sk-[redacted] used"],
      ["gemini AIzaSyA1234567890abcdefghijklmnopqrstu", "gemini AIza[redacted]"],
      ["bot 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawQ x", "bot [telegram-token] x"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "jwt [jwt]"],
      [`posting to ${DISCORD} failed`, "posting to https://discord.com/api/webhooks/[redacted] failed"],
      ["-----BEGIN PRIVATE KEY-----\nMIIEv\n-----END PRIVATE KEY-----", "[pem]"],
      [`sig 0x${"a".repeat(130)} key ${"b".repeat(64)}`, "sig 0x[hex] key [hex]"],
      ["blob QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0NQ==", "blob [base64]"],
    ];
    for (const [input, out] of cases) expect(scrubOpsText(input), input).toBe(out);
  });

  it("removes personal data and control characters, keeps ordinary text", () => {
    expect(scrubOpsText(`user ${ADDRESS} (me@example.com) from 203.0.113.9 and 2001:db8:0:0:0:0:0:1`)).toBe("user 0x[address] ([email]) from [ip] and [ip]");
    expect(scrubOpsText("a\u0000b\u202ec\u200bd\ne\tf")).toBe("abcd\ne\tf");
    const ordinary = "TypeError: Cannot read properties of undefined (reading 'coin')\n    at run (dist/src/engine/worker.js:12:34)";
    expect(scrubOpsText(ordinary)).toBe(ordinary);
  });
});

describe("hostile text", () => {
  it("never leaves half an emoji behind (Postgres refuses jsonb with one)", () => {
    const e = cleanOpsEvent({ severity: "warning", source: "browser", title: "q".repeat(199) + "😀", detail: "d".repeat(1499) + "😀x", context: { route: "/" + "z".repeat(117) + "😀" + "bbbb" } });
    for (const v of [e.title, e.detail, String(e.context.route)]) expect((v as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/\\ud83d(?!\\ude)/i);
    expect(wellFormed("a\uD83Db")).toBe("a\uFFFDb");
    expect(scrubOpsText("x\uDE00y")).toBe("x\uFFFDy");
  });

  it("removes secrets written the way environments and services write them", () => {
    const cases: Array<[string, string]> = [
      ["HMAC_SECRET=abc123 OPENROUTER_API_KEY=sk_live_x DATABASE_PASSWORD=hunter2", "HMAC_SECRET=[redacted] OPENROUTER_API_KEY=[redacted] DATABASE_PASSWORD=[redacted]"],
      ["connect rediss://:s3cretpass@redis:6379 failed", "connect rediss://[credentials]@redis:6379 failed"],
      [`GET /bot123456789:${"A".repeat(35)}/getUpdates`, "GET /bot[telegram-token]/getUpdates"],
      ["session Q2FsbGVkIFdpdGggYSBrZXkgdGhhdF9pcy1sb25nZXI0Mw ok", "session [token] ok"],
      ["AccessDenied on arn:aws:kms:eu-west-1:123456789012:key/abcd for arn:aws:iam::210987654321:role/x", "AccessDenied on arn:aws:kms:eu-west-1:[account]:key/abcd for arn:aws:iam::[account]:role/x"],
      ["key AKIAIOSFODNN7EXAMPLE used", "key [aws-key] used"],
    ];
    for (const [input, out] of cases) expect(scrubOpsText(input), input).toBe(out);
    // Identifiers and paths that only look long stay readable.
    expect(scrubOpsText("at SubAccountDirectory.refreshDue (dist/src/accounts/subAccounts.js:185:9)")).toBe("at SubAccountDirectory.refreshDue (dist/src/accounts/subAccounts.js:185:9)");
  });

  it("stays fast on text crafted to make patterns backtrack", () => {
    const inputs = [
      "-eyJ".repeat(5_000),
      " eyJ" + "a".repeat(20_000),
      "a@".repeat(5_000),
      "a".repeat(7_999) + "g",
      "a_".repeat(4_000) + "=",
      "x://".repeat(3_000),
      "1".repeat(8_000) + ":",
      ("ab.".repeat(30) + "@").repeat(100),
    ];
    for (const input of inputs) {
      const t0 = performance.now();
      scrubOpsText(input);
      expect(performance.now() - t0, input.slice(0, 12)).toBeLessThan(50);
    }
  });
});

describe("grouping", () => {
  it("groups the same error with different values and splits different places", () => {
    const a = opsFingerprint({ source: "worker", title: "job iteration failed", detail: "Error: user 123 not found (id 7d9f…)\n    at load (dist/a.js:10:5)" });
    const b = opsFingerprint({ source: "worker", title: "job iteration failed", detail: "Error: user 98765 not found (id 7d9f…)\n    at load (dist/a.js:10:5)" });
    const c = opsFingerprint({ source: "worker", title: "job iteration failed", detail: "Error: user 1 not found (id 7d9f…)\n    at other (dist/b.js:3:1)" });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps stack frames short and free of machine paths", () => {
    const err = new Error("x");
    err.stack = "Error: x\n    at run (/app/dist/src/engine/worker.js:12:34)\n    at next (/app/node_modules/.pnpm/fastify@5.0.0/node_modules/fastify/lib/route.js:1:2)\n    at file:///kokoah/kokoah-backend/src/a.ts:1:1";
    expect(stackFrames(err)).toEqual(["at run (dist/src/engine/worker.js:12:34)", "at next (~/fastify/lib/route.js:1:2)", "at src/a.ts:1:1"]);
    expect(stackFrames("not an error")).toEqual([]);
  });

  it("aggregates repeats, keeps the worst severity, and counts a flood of kinds into one overflow", () => {
    const agg = new OpsAggregator("api", 3);
    agg.add({ severity: "warning", source: "api", title: "slow", detail: "d" }, 1);
    agg.add({ severity: "error", source: "api", title: "slow", detail: "d" }, 2);
    for (let i = 0; i < 10; i++) agg.add({ severity: "error", source: "api", title: `kind ${String.fromCharCode(97 + i)}` }, 3);
    const out = agg.drain();
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ count: 2, first: 1, last: 2, event: { severity: "error", title: "slow" } });
    expect(out[3]).toMatchObject({ count: 8, event: { title: "Too many different errors at once", fingerprint: "overflow:api" } });
    expect(agg.drain()).toEqual([]);
    agg.restore(out.slice(0, 1));
    agg.add({ severity: "error", source: "api", title: "slow", detail: "d" }, 5);
    expect(agg.drain()[0]).toMatchObject({ count: 3, first: 1 });
  });

  it("cleans every text and keeps only simple context", () => {
    const e = cleanOpsEvent({
      severity: "error",
      source: "api",
      title: `failed for ${ADDRESS}`,
      detail: "x".repeat(5000),
      context: { userId: 7, route: "/v1/x?token=abc", "bad key!": "x", nested: { a: 1 } as unknown as string },
    });
    expect(e.title).toBe("failed for 0x[address]");
    expect(e.detail.length).toBeLessThanOrEqual(1500);
    expect(e.context).toEqual({ userId: 7, route: "/v1/x", nested: null });
  });
});

describe("webhooks", () => {
  it("recognises Discord and Slack-compatible URLs and refuses unsafe ones", () => {
    expect(opsWebhookKind(DISCORD)).toEqual({ kind: "discord" });
    expect(opsWebhookKind(DISCORD.replace("discord.com", "discordapp.com"))).toEqual({ kind: "discord" });
    expect(opsWebhookKind(DISCORD.replace("/api/", "/api/v10/"))).toEqual({ kind: "discord" });
    expect(opsWebhookKind(`${DISCORD}/slack`)).toEqual({ kind: "slack" });
    expect(opsWebhookKind("https://hooks.slack.com/services/T0/B0/x")).toEqual({ kind: "slack" });
    expect(opsWebhookKind("http://127.0.0.1:9000/hook")).toEqual({ kind: "slack" });
    expect(opsWebhookKind("http://hooks.example.com/x")).toEqual({ problem: "must use https" });
    expect(opsWebhookKind("https://user:pw@hooks.example.com/x")).toEqual({ problem: "must not contain credentials" });
    expect(opsWebhookKind("https://discord.com/channels/1/2")).toMatchObject({ problem: expect.stringContaining("Discord webhook URL") });
    expect(opsWebhookKind(`${DISCORD}/github`)).toMatchObject({ problem: expect.stringContaining("github") });
    expect(opsWebhookKind("not a url")).toEqual({ problem: "is not a URL" });
  });

  it("parses a user or role mention, never everyone", () => {
    expect(parseDiscordMention("<@123456789012345678>")).toEqual({ user: "123456789012345678" });
    expect(parseDiscordMention("<@!123456789012345678>")).toEqual({ user: "123456789012345678" });
    expect(parseDiscordMention("<@&123456789012345678>")).toEqual({ role: "123456789012345678" });
    for (const v of ["@everyone", "@here", "123", "<@12>", "", undefined]) expect(parseDiscordMention(v)).toBeNull();
  });

  const alert = (i: number, over: Partial<OpsAlert> = {}): OpsAlert => ({
    severity: "error",
    source: "worker",
    title: `job iteration failed ${i}`,
    detail: "Error: boom\n    at run (dist/a.js:1:2)",
    context: { job: "engine" },
    newCount: 1,
    totalCount: 1,
    firstSeen: 1_700_000_000_000,
    lastSeen: 1_700_000_000_000,
    repeat: false,
    ...over,
  });

  it("builds Discord messages within its limits, with untrusted text unable to ping, link or escape", () => {
    const evil = alert(0, {
      severity: "critical",
      title: "@everyone [click](https://evil.example) <@123>",
      detail: "``` @everyone\n[x](https://evil.example)" + "y".repeat(5000),
      context: { route: "`x` @here" },
    });
    const many = Array.from({ length: 23 }, (_, i) => alert(i + 1, { detail: "z".repeat(1500) }));
    const out = discordPayloads({ alerts: [evil, ...many], problems: [{ kind: "problem", subject: "engine", detail: "no heartbeat for 6 min", since: 1_700_000_000_000 }] }, {
      label: "app.example.com (testnet)",
      mention: { role: "123456789012345678" },
    });
    expect(out.length).toBeGreaterThan(3);
    for (const [i, p] of out.entries()) {
      expect(p.embeds.length).toBeLessThanOrEqual(10);
      const size = p.embeds.reduce((n, e) => n + e.title.length + (e.description?.length ?? 0) + (e.footer?.text.length ?? 0) + (e.fields ?? []).reduce((m, f) => m + f.name.length + f.value.length, 0), 0);
      expect(size).toBeLessThanOrEqual(6000);
      for (const e of p.embeds) {
        expect(e.title.length).toBeLessThanOrEqual(256);
        expect(e.description?.length ?? 0).toBeLessThanOrEqual(4096);
        for (const f of e.fields ?? []) expect(f.value.length).toBeLessThanOrEqual(1024);
      }
      // Only the first message of a batch with a critical alert mentions, and only the configured role.
      expect(p.allowed_mentions).toEqual(i === 0 ? { parse: [], roles: ["123456789012345678"] } : { parse: [] });
      expect(p.content).toBe(i === 0 ? "<@&123456789012345678>" : undefined);
    }
    const first = out[0]!.embeds[1]!;
    expect(first.title).toBe("🔴 CRITICAL · ＠everyone ［click］(https://evil.example) ‹＠123›");
    expect(first.description!.startsWith("```\nˋˋˋ @everyone")).toBe(true);
    expect(first.description!.endsWith("\n```")).toBe(true);
    expect(first.description!.slice(4, -4)).not.toContain("```");
    expect(first.fields!.find((f) => f.name === "Context")!.value).toBe("route: `ˋxˋ @here`");
    expect(out[0]!.embeds[0]!.title).toBe("⚠️ Problem · engine");
  });

  it("says how often a repeat happened", () => {
    const [p] = discordPayloads({ alerts: [alert(1, { repeat: true, newCount: 37, totalCount: 412 })] }, { label: "x" });
    expect(p!.embeds[0]!.title).toContain("(again)");
    expect(p!.embeds[0]!.fields![1]!.value).toBe("×37 more since the last message (412 in all, first <t:1700000000:R>)");
    expect(p!.allowed_mentions).toEqual({ parse: [] });
  });

  it("escapes Slack-compatible text so it can't ping or link", () => {
    const [p] = slackPayloads({ alerts: [alert(1, { title: "<!channel> rotate now: <https://evil.example/x|https://kokoah.app/admin> @here [x](https://evil.example) a&b" })] }, { label: "x" });
    expect(p!.text).toContain("&lt;!channel&gt; rotate now: &lt;https://evil.example/x|https://kokoah.app/admin&gt; ＠here ［x］(https://evil.example) a&amp;b");
    expect(p!.text).not.toMatch(/<!|<https|@here|\[x\]/);
  });

  it("builds Slack-compatible text in parts of at most 3,500 characters", () => {
    const out = slackPayloads({ alerts: Array.from({ length: 30 }, (_, i) => alert(i, { detail: "z".repeat(400) })) }, { label: "x" });
    expect(out.length).toBeGreaterThan(1);
    for (const p of out) expect(p.text.length).toBeLessThanOrEqual(3500);
    expect(out[0]!.text.startsWith("Kokoah x:\n🟠 ERROR · worker: job iteration failed 0 (first time)")).toBe(true);
  });

  const respond = (status: number, body = "", headers: Record<string, string> = {}) => async () => new Response(status === 204 ? null : body, { status, headers });

  it("reads Discord's answers: sent, wait, rejected, refused payload, failed", async () => {
    expect(await postOpsWebhook(DISCORD, {}, respond(204))).toEqual({ ok: true });
    expect(await postOpsWebhook(DISCORD, {}, respond(204, "", { "x-ratelimit-remaining": "0", "x-ratelimit-reset-after": "1.5" }))).toEqual({ ok: true, waitMs: 1500 });
    expect(await postOpsWebhook(DISCORD, {}, respond(429, '{"retry_after": 2.5, "global": false}'))).toEqual({ ok: false, retryAfterMs: 2500 });
    expect(await postOpsWebhook(DISCORD, {}, respond(429, "", { "retry-after": "7" }))).toEqual({ ok: false, retryAfterMs: 7000 });
    expect(await postOpsWebhook(DISCORD, {}, respond(404, '{"message": "Unknown Webhook", "code": 10015}'))).toEqual({ ok: false, rejected: 404 });
    expect(await postOpsWebhook(DISCORD, {}, respond(400, '{"message": "Invalid Form Body", "code": 50035}'))).toEqual({ ok: false, badPayload: 400, reason: "50035 Invalid Form Body" });
    expect(await postOpsWebhook(DISCORD, {}, respond(502))).toEqual({ ok: false, failed: "HTTP 502" });
    const down = await postOpsWebhook(DISCORD, {}, async () => {
      throw new TypeError(`fetch failed ${DISCORD}`);
    });
    expect(down).toEqual({ ok: false, failed: "unreachable (TypeError)" });
    expect(JSON.stringify(down)).not.toContain("abcdefghij");
  });

  it("sends a batch in order, replaces a refused message with a plain notice, and stops at a failure", async () => {
    const bodies: string[] = [];
    let n = 0;
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(String(init?.body));
      n++;
      return n === 1 ? new Response('{"message":"Invalid Form Body","code":50035}', { status: 400 }) : new Response(null, { status: 204 });
    };
    expect(await sendOpsBatch(DISCORD, { alerts: [alert(1)] }, { label: "x", fetchFn: fetchFn as typeof fetch })).toEqual({
      ok: true,
      sent: { messages: 1, alerts: [0], problems: [], note: false },
    });
    expect(JSON.parse(bodies[1]!)).toEqual({
      content: "Kokoah x: 1 alert(s) could not be formatted (50035 Invalid Form Body):\n- error: job iteration failed 1",
      username: "Kokoah alerts",
      allowed_mentions: { parse: [] },
    });
    const failing = async () => new Response(null, { status: 503 });
    expect(await sendOpsBatch(DISCORD, { alerts: Array.from({ length: 25 }, (_, i) => alert(i)) }, { label: "x", fetchFn: failing as typeof fetch })).toEqual({
      ok: false,
      failed: "HTTP 503",
      sent: { messages: 0, alerts: [], problems: [], note: false },
    });
    expect(await sendOpsBatch("http://hooks.example.com/x", { alerts: [alert(1)] }, { label: "x" })).toMatchObject({ ok: false, rejected: 0 });
  });

  it("says exactly what went out before a 429 halfway, so nothing (and no mention) is posted twice", async () => {
    const bodies: DiscordPayload[] = [];
    const fetchFn = async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as DiscordPayload);
      return bodies.length === 2 ? new Response('{"retry_after": 3}', { status: 429 }) : new Response(null, { status: 204 });
    };
    const alerts = [alert(0, { severity: "critical" }), ...Array.from({ length: 14 }, (_, i) => alert(i + 1))];
    const problems = [{ kind: "problem" as const, subject: "engine", detail: "no heartbeat for 6 min", critical: true }];
    const r = await sendOpsBatch(DISCORD, { alerts, problems, note: "3 more kinds of events" }, { label: "x", mention: { user: "123456789012345678" }, fetchFn: fetchFn as typeof fetch });
    expect(r).toEqual({ ok: false, retryAfterMs: 3000, sent: { messages: 1, alerts: [0, 1, 2, 3, 4, 5, 6, 7, 8], problems: [0], note: false } });
    expect(bodies[0]!.content).toBe("<@123456789012345678>");
    expect(bodies[1]!.content).toBeUndefined();
    // What is left is posted next time, without the mention (its critical items went out).
    const left = { alerts: alerts.filter((_, i) => !r.sent.alerts.includes(i)), note: "3 more kinds of events" };
    const again = await sendOpsBatch(DISCORD, left, { label: "x", mention: { user: "123456789012345678" }, fetchFn: (async () => new Response(null, { status: 204 })) as typeof fetch });
    expect(again).toEqual({ ok: true, sent: { messages: 1, alerts: [0, 1, 2, 3, 4, 5], problems: [], note: true } });
  });

  it("drops a message refused even in plain form, and goes on with the rest next time", async () => {
    let n = 0;
    const fetchFn = async () => (++n <= 2 ? new Response('{"message":"Invalid Form Body","code":50035}', { status: 400 }) : new Response(null, { status: 204 }));
    const r = await sendOpsBatch(DISCORD, { alerts: Array.from({ length: 12 }, (_, i) => alert(i)) }, { label: "x", fetchFn: fetchFn as typeof fetch });
    expect(r).toEqual({ ok: false, badPayload: 400, reason: "50035 Invalid Form Body", sent: { messages: 0, alerts: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], problems: [], note: false } });
  });

  it("mentions on a critical problem, never on a warning problem or an all-clear", () => {
    const mention = { role: "123456789012345678" };
    const [warn] = discordPayloads({ problems: [{ kind: "problem", subject: "notifications", detail: "12 waiting" }] }, { label: "x", mention });
    expect(warn!.content).toBeUndefined();
    expect(warn!.embeds[0]!.title).toBe("⚠️ Problem · notifications");
    const [down] = discordPayloads({ problems: [{ kind: "problem", subject: "signer service", detail: "unreachable", critical: true }] }, { label: "x", mention });
    expect(down!.content).toBe("<@&123456789012345678>");
    expect(down!.allowed_mentions).toEqual({ parse: [], roles: ["123456789012345678"] });
    expect(down!.embeds[0]!.title).toBe("🔴 Problem · signer service");
    const [clear] = discordPayloads({ problems: [{ kind: "resolved", subject: "signer service", detail: "was: unreachable", critical: true }] }, { label: "x", mention });
    expect(clear!.content).toBeUndefined();
    expect(slackPayloads({ problems: [{ kind: "problem", subject: "engine", detail: "no heartbeat", critical: true }] }, { label: "x" })[0]!.text).toBe("Kokoah x:\n🔴 problem · engine: no heartbeat");
  });
});
