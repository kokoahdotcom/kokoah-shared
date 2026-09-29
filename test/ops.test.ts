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
    expect(await sendOpsBatch(DISCORD, { alerts: [alert(1)] }, { label: "x", fetchFn: fetchFn as typeof fetch })).toEqual({ ok: true });
    expect(JSON.parse(bodies[1]!)).toEqual({
      content: "Kokoah x: 1 alert(s) could not be formatted (50035 Invalid Form Body):\n- error: job iteration failed 1",
      username: "Kokoah alerts",
      allowed_mentions: { parse: [] },
    });
    const failing = async () => new Response(null, { status: 503 });
    expect(await sendOpsBatch(DISCORD, { alerts: Array.from({ length: 25 }, (_, i) => alert(i)) }, { label: "x", fetchFn: failing as typeof fetch })).toEqual({ ok: false, failed: "HTTP 503" });
    expect(await sendOpsBatch("http://hooks.example.com/x", { alerts: [alert(1)] }, { label: "x" })).toEqual({ ok: false, rejected: 0 });
  });
});
