/**
 * READ-ONLY WebSocket spike (testnet): does subscribing to a non-existent coin drop the whole connection silently?
 *
 * Connection A: subscribe to `trades` for a valid coin, wait, then subscribe to `l2Book` for an invalid coin and watch
 *               for error messages and the close event.
 * Connection B: subscribe to an invalid HIP-3-style coin (`xyz:NOTACOIN`) alone.
 * Connection C: send an unknown subscription TYPE, to compare (research: error message, socket stays open).
 *
 * No keys, no /exchange. One `/info` request (`meta`) to pick and validate a real coin. Uses Node's global WebSocket.
 *   node spikes/ws-invalid-coin.ts
 */
import { MarketRegistry, parseNetworkName, TESTNET } from "@kokoah/shared";

if (parseNetworkName(process.env.HL_NETWORK) !== "testnet") {
  console.error("REFUSING TO RUN: this spike only targets testnet");
  process.exit(2);
}

interface Trace {
  label: string;
  events: Array<{ t: number; type: string; detail?: unknown }>;
  closed: boolean;
}

const meta = await (await fetch(TESTNET.infoUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "meta" }) })).json();
const registry = MarketRegistry.fromInfo({ meta });
const valid = registry.has("BTC") ? "BTC" : (registry.list()[0]?.coin as string);
console.log(`valid coin: ${valid} → validateCoin ok=${registry.validateCoin(valid).ok}`);
console.log(`NOTACOIN → ${JSON.stringify(registry.validateCoin("NOTACOIN"))}`);

function run(label: string, steps: Array<{ at: number; send: unknown }>, watchMs: number): Promise<Trace> {
  return new Promise((resolve) => {
    const trace: Trace = { label, events: [], closed: false };
    const t0 = Date.now();
    const log = (type: string, detail?: unknown) => trace.events.push({ t: Date.now() - t0, type, ...(detail !== undefined ? { detail } : {}) });
    const ws = new WebSocket(TESTNET.wsUrl);
    const timers: ReturnType<typeof setTimeout>[] = [];
    let messages = 0;
    ws.addEventListener("open", () => {
      log("open");
      for (const s of steps) timers.push(setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(s.send));
          log("sent", s.send);
        } else log("not-sent (socket not open)", s.send);
      }, s.at));
    });
    ws.addEventListener("message", (ev) => {
      messages++;
      const text = String(ev.data);
      let channel = "?";
      try {
        channel = (JSON.parse(text) as { channel?: string }).channel ?? "?";
      } catch {}
      // Log acks, errors and the first message of each channel; count the rest.
      if (channel !== "trades" && channel !== "l2Book" || messages <= 2) log(`message:${channel}`, text.slice(0, 300));
    });
    ws.addEventListener("error", (ev) => log("error", (ev as unknown as { message?: string }).message ?? "error event"));
    ws.addEventListener("close", (ev) => {
      trace.closed = true;
      log("close", { code: ev.code, reason: ev.reason, wasClean: ev.wasClean });
      finish();
    });
    const finish = () => {
      for (const t of timers) clearTimeout(t);
      log("summary", { totalMessages: messages });
      resolve(trace);
    };
    setTimeout(() => {
      if (!trace.closed) {
        log("still-open-at-end");
        ws.close(1000, "spike done");
      }
    }, watchMs);
  });
}

const a = await run(
  "A: valid trades, then invalid l2Book",
  [
    { at: 200, send: { method: "subscribe", subscription: { type: "trades", coin: valid } } },
    { at: 4000, send: { method: "ping" } },
    { at: 5000, send: { method: "subscribe", subscription: { type: "l2Book", coin: "NOTACOIN" } } },
    { at: 15000, send: { method: "ping" } },
  ],
  20000,
);
const b = await run("B: invalid HIP-3 coin alone", [{ at: 200, send: { method: "subscribe", subscription: { type: "trades", coin: "xyz:NOTACOIN" } } }, { at: 8000, send: { method: "ping" } }], 12000);
const c = await run("C: unknown subscription type", [{ at: 200, send: { method: "subscribe", subscription: { type: "notARealType", coin: valid } } }, { at: 4000, send: { method: "ping" } }], 8000);

console.log(JSON.stringify({ when: new Date().toISOString(), endpoint: TESTNET.wsUrl, validCoin: valid, traces: [a, b, c] }, null, 2));
