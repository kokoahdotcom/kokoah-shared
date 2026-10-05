import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { agentAttestationProblem, buildAgentAttestationTypedData, isAttestationChallenge, type AgentAttestationFields } from "../src/signing/index.js";

const attester = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const other = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const USER = "0x1111111111111111111111111111111111111111";
const AGENT = "0x2222222222222222222222222222222222222222";
const NOW = 1_790_000_000_000;
const CHALLENGE = `0x${"ab".repeat(32)}` as const;
const agent = { agentAddress: AGENT, agentName: "kokoah-bot", validUntil: NOW + 30 * 86_400_000 };
const fields: AgentAttestationFields = { user: USER, agent: AGENT, network: "Testnet", agentName: "kokoah-bot", validUntil: agent.validUntil, challenge: CHALLENGE, issuedAt: NOW };
const expected = { attesters: [attester.address], user: USER, network: "Testnet" as const, challenge: CHALLENGE, now: NOW };
const attest = async (f: AgentAttestationFields = fields, by = attester) => ({ issuedAt: f.issuedAt, signature: await by.signTypedData(buildAgentAttestationTypedData(f)) });

describe("agent attestations", () => {
  it("accept the attester's signature over the agent, user, network, name, expiry and challenge", async () => {
    expect(await agentAttestationProblem(await attest(), agent, expected)).toBeNull();
    // Addresses compare without case.
    expect(await agentAttestationProblem(await attest(), { ...agent, agentAddress: AGENT.toUpperCase().replace("0X", "0x") }, { ...expected, attesters: [attester.address.toLowerCase()] })).toBeNull();
  });

  it("refuse an agent the attester didn't sign for", async () => {
    const att = await attest();
    expect(await agentAttestationProblem(att, { ...agent, agentAddress: "0x3333333333333333333333333333333333333333" }, expected)).toMatch(/not made by/);
    expect(await agentAttestationProblem(att, { ...agent, agentName: "evil-bot" }, expected)).toMatch(/not made by/);
    expect(await agentAttestationProblem(att, { ...agent, validUntil: agent.validUntil + 1 }, expected)).toMatch(/not made by/);
    expect(await agentAttestationProblem(att, agent, { ...expected, user: "0x4444444444444444444444444444444444444444" })).toMatch(/not made by/);
    expect(await agentAttestationProblem(att, agent, { ...expected, network: "Mainnet" })).toMatch(/not made by/);
    expect(await agentAttestationProblem(att, agent, { ...expected, challenge: `0x${"cd".repeat(32)}` })).toMatch(/not made by/);
  });

  it("refuse a self-consistent attestation by another key", async () => {
    expect(await agentAttestationProblem(await attest(fields, other), agent, expected)).toMatch(/not made by/);
  });

  it("refuse stale, future, missing and malformed attestations", async () => {
    const old = { ...fields, issuedAt: NOW - 11 * 60_000 };
    expect(await agentAttestationProblem(await attest(old), agent, expected)).toMatch(/not recent/);
    const ahead = { ...fields, issuedAt: NOW + 6 * 60_000 };
    expect(await agentAttestationProblem(await attest(ahead), agent, expected)).toMatch(/not recent/);
    const att = await attest();
    expect(await agentAttestationProblem({ ...att, issuedAt: NOW + 1 }, agent, expected)).toMatch(/not made by/);
    expect(await agentAttestationProblem(undefined, agent, expected)).toMatch(/no signer attestation/);
    expect(await agentAttestationProblem({ issuedAt: NOW, signature: "0x12" }, agent, expected)).toMatch(/malformed/);
    expect(await agentAttestationProblem({ signature: att.signature }, agent, expected)).toMatch(/malformed/);
    expect(await agentAttestationProblem(att, { ...agent, agentAddress: "nope" }, expected)).toMatch(/malformed/);
    expect(await agentAttestationProblem(att, agent, { ...expected, attesters: [] })).toMatch(/No signer attestation key/);
  });

  it("check their fields when built", () => {
    expect(() => buildAgentAttestationTypedData({ ...fields, agent: "0x0000000000000000000000000000000000000000" })).toThrow(RangeError);
    expect(() => buildAgentAttestationTypedData({ ...fields, challenge: "0x12" })).toThrow(RangeError);
    expect(() => buildAgentAttestationTypedData({ ...fields, validUntil: 0 })).toThrow(RangeError);
    expect(isAttestationChallenge(CHALLENGE)).toBe(true);
    expect(isAttestationChallenge("0x12")).toBe(false);
    expect(isAttestationChallenge(42)).toBe(false);
  });
});
