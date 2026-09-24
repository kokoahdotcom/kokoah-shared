import { describe, expect, it } from "vitest";
import { accountOf, isAccountAddress, MAX_SUB_ACCOUNTS, parseSubAccounts, SubAccountLookupError, SubAccountOwnership } from "../src/subaccounts/index.js";

const MASTER = "0x9ae70bbaffbfa07a5a67b7b02f05addf033b0b55";
const SUB_A = "0x34f3563269406e726d355e1e962459144cbe6390";
const SUB_B = "0xe2e8fa6265d471db90f77d1d70db99ab3dbca93f";
const OTHER = "0xcdbc1a93b29ff618285f551cb684213e7e2ad357";
const entry = (sub: string, master = MASTER, name = "Swing") => ({ name, subAccountUser: sub, master, clearinghouseState: {}, spotState: { balances: [] } });

describe("parseSubAccounts", () => {
  it("reads HL's answer (null when there are none)", () => {
    expect(parseSubAccounts(null, MASTER)).toEqual([]);
    expect(parseSubAccounts([entry(SUB_A.toUpperCase().replace("0X", "0x"), MASTER.toUpperCase().replace("0X", "0x"), "  Swing  ")], MASTER)).toEqual([
      { address: SUB_A, name: "Swing", master: MASTER },
    ]);
  });
  it("fails closed on entries that are malformed, of another master, the master itself or repeated", () => {
    const list = parseSubAccounts(
      [entry(SUB_A), entry(SUB_B, OTHER), entry(MASTER), entry("0x0000000000000000000000000000000000000000"), entry(SUB_A, MASTER, "again"), { name: "x" }, null, "0x", entry("0x12")],
      MASTER,
    );
    expect(list.map((s) => s.address)).toEqual([SUB_A]);
    expect(list[0]?.name).toBe("Swing");
  });
  it("keeps names short, tolerates missing names and caps the count", () => {
    expect(parseSubAccounts([{ subAccountUser: SUB_A, master: MASTER }], MASTER)[0]?.name).toBe("");
    expect(parseSubAccounts([entry(SUB_A, MASTER, "x".repeat(200))], MASTER)[0]?.name).toHaveLength(64);
    const many = Array.from({ length: 60 }, (_, i) => entry(`0x${(i + 1).toString(16).padStart(40, "0")}`));
    expect(parseSubAccounts(many, MASTER)).toHaveLength(MAX_SUB_ACCOUNTS);
  });
  it("throws on an answer that is not a list, and on a bad master", () => {
    expect(() => parseSubAccounts({ error: "x" }, MASTER)).toThrow(TypeError);
    expect(() => parseSubAccounts([], "0x1")).toThrow(RangeError);
  });
});

describe("accountOf", () => {
  it("is the sub-account when set, else the master, lowercase", () => {
    expect(accountOf(MASTER.toUpperCase().replace("0X", "0x"))).toBe(MASTER);
    expect(accountOf(MASTER, SUB_A.toUpperCase().replace("0X", "0x"))).toBe(SUB_A);
    expect(accountOf(MASTER, null)).toBe(MASTER);
    expect(() => accountOf(MASTER, "0x1")).toThrow(RangeError);
    expect(isAccountAddress(SUB_A)).toBe(true);
    expect(isAccountAddress("0x1")).toBe(false);
  });
});

describe("SubAccountOwnership", () => {
  function setup(answers: Record<string, unknown>) {
    let now = 1_000_000;
    const calls: string[] = [];
    const owner = new SubAccountOwnership({
      now: () => now,
      load: async (master) => {
        calls.push(master);
        const a = answers[master];
        if (a instanceof Error) throw a;
        return a ?? null;
      },
    });
    return { owner, calls, tick: (ms: number) => (now += ms), answers };
  }

  it("allows only sub-accounts HL lists for that master", async () => {
    const { owner } = setup({ [MASTER]: [entry(SUB_A)], [OTHER]: [entry(SUB_B, OTHER)] });
    expect(await owner.isOwned(MASTER, SUB_A)).toBe(true);
    expect(await owner.isOwned(MASTER, SUB_B)).toBe(false);
    expect(await owner.isOwned(MASTER, MASTER)).toBe(false);
    expect(await owner.isOwned(OTHER, SUB_B)).toBe(true);
    expect(await owner.find(MASTER.toUpperCase().replace("0X", "0x"), SUB_A.toUpperCase().replace("0X", "0x"))).toEqual({ address: SUB_A, name: "Swing", master: MASTER });
  });

  it("serves hits from the cache and re-reads a stale list", async () => {
    const { owner, calls, tick } = setup({ [MASTER]: [entry(SUB_A)] });
    await owner.isOwned(MASTER, SUB_A);
    await owner.isOwned(MASTER, SUB_A);
    expect(calls).toHaveLength(1);
    tick(30_000);
    await owner.isOwned(MASTER, SUB_A);
    expect(calls).toHaveLength(2);
  });

  it("re-reads HL on a miss once the list is a few seconds old (a new sub-account)", async () => {
    const { owner, calls, tick, answers } = setup({ [MASTER]: [entry(SUB_A)] });
    expect(await owner.isOwned(MASTER, SUB_B)).toBe(false);
    expect(calls).toHaveLength(1);
    // A second miss right away does not hit HL again.
    expect(await owner.isOwned(MASTER, SUB_B)).toBe(false);
    expect(calls).toHaveLength(1);
    answers[MASTER] = [entry(SUB_A), entry(SUB_B)];
    tick(5_000);
    expect(await owner.isOwned(MASTER, SUB_B)).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it("shares one read between concurrent checks", async () => {
    const { owner, calls } = setup({ [MASTER]: [entry(SUB_A)] });
    await Promise.all([owner.isOwned(MASTER, SUB_A), owner.isOwned(MASTER, SUB_B), owner.list(MASTER)]);
    expect(calls).toHaveLength(1);
  });

  it("throws (never allows) when HL can't be read or answers nonsense, and caches nothing then", async () => {
    const { owner, calls, answers } = setup({ [MASTER]: new Error("network") });
    await expect(owner.isOwned(MASTER, SUB_A)).rejects.toBeInstanceOf(SubAccountLookupError);
    answers[MASTER] = { error: "bad" };
    await expect(owner.list(MASTER)).rejects.toBeInstanceOf(SubAccountLookupError);
    answers[MASTER] = [entry(SUB_A)];
    expect(await owner.isOwned(MASTER, SUB_A)).toBe(true);
    expect(calls).toHaveLength(3);
  });

  it("does not trust a list when the clock went backwards, and forgets on invalidate", async () => {
    const { owner, calls, tick } = setup({ [MASTER]: [entry(SUB_A)] });
    await owner.list(MASTER);
    tick(-1);
    await owner.list(MASTER);
    expect(calls).toHaveLength(2);
    owner.invalidate(MASTER);
    await owner.list(MASTER);
    owner.invalidate();
    await owner.list(MASTER);
    expect(calls).toHaveLength(4);
  });

  it("keeps a bounded number of masters", async () => {
    const answers: Record<string, unknown> = {};
    const masters = Array.from({ length: 3 }, (_, i) => `0x${(i + 10).toString(16).padStart(40, "0")}`);
    const calls: string[] = [];
    const owner = new SubAccountOwnership({ maxMasters: 2, load: async (m) => (calls.push(m), answers[m] ?? null) });
    for (const m of masters) await owner.list(m);
    await owner.list(masters[2]!);
    await owner.list(masters[0]!);
    expect(calls).toEqual([masters[0], masters[1], masters[2], masters[0]]);
  });

  it("returns copies, so callers can't change the cache", async () => {
    const { owner } = setup({ [MASTER]: [entry(SUB_A)] });
    const list = await owner.list(MASTER);
    list.pop();
    expect(await owner.list(MASTER)).toHaveLength(1);
  });
});
