/**
 * Test runner: pure-logic unit tests plus an offline streaming test.
 *
 * Run: node test/run.mjs
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadableStream } from "node:stream/web";
import { parseModelCatalog, normalizeCredits, toProviderModels, modelLabel, billingLabel, toProviderVariants } from "../src/catalog.js";
import {
  applyProviders,
  buildProviderBlock,
  globalConfigDir,
  isManaged,
  parseJsonc,
  removeProviders,
  validateConfigDocument,
  writeConfig,
} from "../src/provider.js";
import { classifyUpstreamError, extractDisplayErrorMessage, prepareChatBody, regionOf } from "../src/upstream.js";
import { classifyAuthDocument, parseWorkBuddyAuth } from "../src/auth.js";
import { buildAuthenticatedContextAad, parseWrappedField } from "../src/protection.js";
import { RelayServer } from "../src/server.js";

let passed = 0;
const failures = [];

/** Run one named test, recording failures instead of aborting the suite. */
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ok   ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`);
  }
}

process.stdout.write("\ncatalog\n");

await test("normalizeCredits strips the unit word", () => {
  assert.equal(normalizeCredits("x0.79 credits"), "x0.79");
  assert.equal(normalizeCredits("x0.00"), "x0.00");
  assert.equal(normalizeCredits("credits"), undefined);
  assert.equal(normalizeCredits(""), undefined);
  assert.equal(normalizeCredits(undefined), undefined);
});

await test("parseModelCatalog reads a models map", () => {
  const models = parseModelCatalog(
    { models: { "glm-5.3": { name: "GLM-5.3", contextWindow: 1000000, supportsImages: true, credits: "x0.79 credits", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high"], defaultEffort: "high" } } } },
    false,
  );
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "glm-5.3");
  assert.equal(models[0].name, "GLM-5.3");
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(models[0].supportsImages, true);
  assert.equal(models[0].billing.credits, "x0.79 credits");
  assert.equal(models[0].billing.free, false);
  assert.deepEqual(models[0].reasoning.supportedEfforts, ["low", "high"]);
});

await test("parseModelCatalog marks free models", () => {
  const models = parseModelCatalog({ models: { free: { name: "Free", credits: "x0.00 credits" } } });
  assert.equal(models[0].billing.free, true);
});

await test("parseModelCatalog skips disabled rows and duplicates", () => {
  const models = parseModelCatalog({
    models: { a: { name: "A" }, b: { name: "B", enabled: false }, c: { name: "C", available: false } },
  });
  assert.deepEqual(models.map((m) => m.id), ["a"]);
});

await test("parseModelCatalog filters invalid effort spellings", () => {
  const models = parseModelCatalog({
    models: { m: { name: "M", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "bogus"], defaultEffort: "bogus" } } },
  });
  assert.deepEqual(models[0].reasoning.supportedEfforts, ["low"]);
  assert.equal(models[0].reasoning.defaultEffort, undefined);
});

await test("modelLabel is the plain model name", () => {
  // The rate must NOT be baked into the configured name: that string is static,
  // so a rate inside it would go stale instead of tracking upstream pricing.
  const models = parseModelCatalog({
    models: { a: { name: "GLM-5.2", credits: "x0.79 credits" }, b: { name: "Hy3", credits: "x0.00 credits" } },
  });
  assert.equal(modelLabel(models[0]), "GLM-5.2");
  assert.equal(modelLabel(models[1]), "Hy3");
});

await test("modelLabel ignores promo badges too", () => {
  const models = parseModelCatalog({
    models: { a: { name: "Hy4 preview", credits: "x0.00 credits", tags: ["badge:限时免费:blue"] } },
  });
  assert.equal(modelLabel(models[0]), "Hy4 preview");
});

await test("billingLabel carries the rate and badges for the live view", () => {
  const models = parseModelCatalog({
    models: { a: { name: "Hy4 preview", credits: "x0.00 credits", tags: ["badge:限时免费:blue"] } },
  });
  // Language-neutral: the English unit word is stripped.
  assert.equal(billingLabel(models[0]), "x0.00  限时免费");
  const plain = parseModelCatalog({ models: { b: { name: "Plain" } } });
  assert.equal(billingLabel(plain[0]), "");
});

await test("toProviderModels writes the bare model name", () => {
  const models = parseModelCatalog({
    models: { m: { name: "GLM-5.3", credits: "x0.79 credits", contextWindow: 1000, maxTokens: 100 } },
  });
  const out = toProviderModels(models);
  assert.equal(out.m.name, "GLM-5.3");
  assert.ok(!/x\d/u.test(out.m.name), "no rate may appear in the configured name");
});

await test("toProviderVariants maps declared efforts to reasoningEffort", () => {
  const models = parseModelCatalog({
    models: { m: { name: "M", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "high", "max"], defaultEffort: "high" } } },
  });
  const variants = toProviderVariants(models[0]);
  assert.deepEqual(variants, {
    low: { reasoningEffort: "low" },
    high: { reasoningEffort: "high" },
    max: { reasoningEffort: "max" },
  });
});

await test("toProviderVariants returns nothing without a declared list", () => {
  // No reasoning support at all, and a model with no reasoning block.
  const plain = parseModelCatalog({ models: { p: { name: "P" } } });
  assert.equal(toProviderVariants(plain[0]), undefined);
  const notReasoning = parseModelCatalog({ models: { n: { name: "N", supportsReasoning: false } } });
  assert.equal(toProviderVariants(notReasoning[0]), undefined);
  // Declared but entirely invalid spellings: the parser strips them, so no
  // variant survives and none is invented.
  const allBogus = parseModelCatalog({ models: { b: { name: "B", supportsReasoning: true, reasoning: { supportedEfforts: ["bogus", "nonsense"] } } } });
  assert.equal(allBogus[0].reasoning.supportedEfforts, undefined);
  assert.equal(toProviderVariants(allBogus[0]), undefined);
});

await test("toProviderVariants keeps only the valid spellings from a mixed list", () => {
  const models = parseModelCatalog({
    models: { m: { name: "M", supportsReasoning: true, reasoning: { supportedEfforts: ["low", "bogus", "max"] } } },
  });
  assert.deepEqual(toProviderVariants(models[0]), {
    low: { reasoningEffort: "low" },
    max: { reasoningEffort: "max" },
  });
});

await test("variants reach the provider config", () => {
  const models = parseModelCatalog({
    models: { m: { name: "M", contextWindow: 1000, maxTokens: 100, supportsReasoning: true, reasoning: { supportedEfforts: ["high", "max"], defaultEffort: "max" } } },
  });
  const out = toProviderModels(models);
  assert.deepEqual(out.m.variants, { high: { reasoningEffort: "high" }, max: { reasoningEffort: "max" } });
  assert.equal(out.m.reasoning, true);
  assert.equal(out.m.options.reasoningEffort, "max");
});

await test("probed efforts are used when the upstream declares none", () => {
  // Simulates what probeEfforts writes back onto the catalog entry.
  const models = parseModelCatalog({ models: { m: { name: "M", contextWindow: 1000, maxTokens: 100, supportsReasoning: true } } });
  assert.equal(toProviderVariants(models[0]), undefined, "no variants before probing");
  models[0].reasoning.supportedEfforts = ["low", "medium", "high", "xhigh", "max"];
  models[0].reasoning.defaultEffort = "high";
  const out = toProviderModels(models);
  assert.deepEqual(Object.keys(out.m.variants), ["low", "medium", "high", "xhigh", "max"]);
});

await test("unavailable models are not offered", () => {
  const models = parseModelCatalog({ models: { gone: { name: "Gone" }, here: { name: "Here" } } });
  models[0].unavailable = true;
  const out = toProviderModels(models);
  assert.deepEqual(Object.keys(out), ["here"]);
});

await test("ProbeStore caches per account and invalidates on fingerprint change", async () => {
  const { ProbeStore } = await import("../src/probe-store.js");
  const store = new ProbeStore(`test-probe-${process.pid}-${Date.now()}.json`);
  const model = { id: "m", contextWindow: 1000, maxTokens: 100, supportsImages: false };
  assert.equal(store.get("acct", model), undefined, "empty cache");
  store.set("acct", model, ["low", "high"]);
  assert.deepEqual(store.get("acct", model), { efforts: ["low", "high"], unavailable: false });
  assert.equal(store.get("other", model), undefined, "cache is per account");
  // A model whose shape changed must not reuse the old answer.
  const changed = { ...model, contextWindow: 2000 };
  assert.equal(store.get("acct", changed), undefined, "fingerprint change invalidates");
});

await test("ProbeStore remembers that a model is unavailable", async () => {
  // An empty effort list alone cannot tell "unavailable" from "no level
  // accepted"; losing that distinction let uncallable models back into the
  // picker on a later cached run.
  const { ProbeStore } = await import("../src/probe-store.js");
  const store = new ProbeStore(`test-probe3-${process.pid}-${Date.now()}.json`);
  const model = { id: "gone", contextWindow: 1, maxTokens: 1, supportsImages: false };
  store.set("acct", model, [], true);
  assert.deepEqual(store.get("acct", model), { efforts: [], unavailable: true });

  const other = { id: "ok", contextWindow: 1, maxTokens: 1, supportsImages: false };
  store.set("acct", other, [], false);
  assert.deepEqual(store.get("acct", other), { efforts: [], unavailable: false });
});

await test("resolveEfforts replays unavailability from cache", async () => {
  const { resolveEfforts, ProbeStore } = await import("../src/probe-store.js");
  const store = new ProbeStore(`test-probe4-${process.pid}-${Date.now()}.json`);
  let probes = 0;
  const upstream = { async probeEffort() { probes += 1; return "unavailable"; } };
  const model = { id: "m", contextWindow: 1, maxTokens: 1, supportsImages: false, reasoning: { supports: true } };

  const first = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "high"], account: "a", store });
  assert.equal(first.unavailable, true);
  const second = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "high"], account: "a", store });
  assert.equal(second.unavailable, true, "cache must still report unavailable");
  assert.equal(probes, 1, "cache avoided a second probe");
});

await test("resolveEfforts prefers declared levels and does not probe them", async () => {
  const { resolveEfforts } = await import("../src/probe-store.js");
  let probes = 0;
  const upstream = { async probeEffort() { probes += 1; return "accepted"; } };
  const model = { id: "m", reasoning: { supports: true, supportedEfforts: ["low", "high"] } };
  const result = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "high", "max"], account: "a" });
  assert.deepEqual(result.efforts, ["low", "high"]);
  assert.equal(probes, 0, "declared levels cost no requests");
});

await test("resolveEfforts probes when undeclared and caches the result", async () => {
  const { resolveEfforts, ProbeStore } = await import("../src/probe-store.js");
  const store = new ProbeStore(`test-probe2-${process.pid}-${Date.now()}.json`);
  let probes = 0;
  const upstream = {
    async probeEffort(_c, _m, effort) {
      probes += 1;
      return effort === "xhigh" ? "rejected" : "accepted";
    },
  };
  const model = { id: "m", contextWindow: 1, maxTokens: 1, supportsImages: false, reasoning: { supports: true } };
  const first = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "xhigh"], account: "a", store });
  assert.deepEqual(first.efforts, ["low"]);
  assert.equal(probes, 2);
  // Second pass must be served from cache.
  const second = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "xhigh"], account: "a", store });
  assert.deepEqual(second.efforts, ["low"]);
  assert.equal(probes, 2, "cache avoided more probes");
});

await test("resolveEfforts stops early when the model is unavailable", async () => {
  const { resolveEfforts } = await import("../src/probe-store.js");
  let probes = 0;
  const upstream = { async probeEffort() { probes += 1; return "unavailable"; } };
  const model = { id: "m", reasoning: { supports: true } };
  const result = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "medium", "high"], account: "a" });
  assert.equal(result.unavailable, true);
  assert.deepEqual(result.efforts, []);
  assert.equal(probes, 1, "one unavailable result is conclusive");
});

await test("resolveEfforts never counts an inconclusive probe as accepted", async () => {
  const { resolveEfforts } = await import("../src/probe-store.js");
  const upstream = { async probeEffort() { return "inconclusive"; } };
  const model = { id: "m", reasoning: { supports: true } };
  const result = await resolveEfforts({ upstream, credential: {}, model, candidates: ["low", "high"], account: "a" });
  assert.deepEqual(result.efforts, [], "ambiguous levels are excluded, not guessed");
  assert.equal(result.unavailable, false);
});

await test("toProviderModels emits MiMoCode model options", () => {
  const models = parseModelCatalog({
    models: { m: { name: "M", contextWindow: 200000, maxTokens: 8000, supportsImages: true, supportsReasoning: true, reasoning: { supportedEfforts: ["high"], defaultEffort: "high" } } },
  });
  const out = toProviderModels(models);
  // output must live inside limit; a top-level output invalidates the config.
  assert.deepEqual(out.m, {
    name: "M",
    limit: { context: 200000, output: 8000 },
    attachment: true,
    reasoning: true,
    options: { reasoningEffort: "high" },
    variants: { high: { reasoningEffort: "high" } },
  });
  assert.equal(out.m.output, undefined);
});

await test("toProviderModels omits limit when either bound is unknown", () => {
  const models = parseModelCatalog({
    models: { a: { name: "A", contextWindow: 1000 }, b: { name: "B", maxTokens: 10 } },
  });
  const out = toProviderModels(models);
  // limit requires both fields, so a partial pair must not be emitted at all.
  assert.equal(out.a.limit, undefined);
  assert.equal(out.b.limit, undefined);
});

await test("generated provider block passes schema validation", () => {
  const block = buildProviderBlock({
    port: 8791,
    providerId: "workbuddy",
    displayName: "WorkBuddy",
    models: toProviderModels(
      parseModelCatalog({ models: { m: { name: "M", contextWindow: 1000, maxTokens: 100, supportsImages: true } } }),
    ),
  });
  const document = applyProviders({}, { workbuddy: block }, "workbuddy/m");
  assert.deepEqual(validateConfigDocument(document), []);
  assert.equal(document.mimoWorkbuddyConnect, undefined, "no root marker may be written");
});

await test("validation rejects a root marker and a misplaced output", () => {
  // Exactly the two defects this project shipped once.
  const bad = {
    $schema: "x",
    model: "workbuddy/m",
    provider: { workbuddy: { name: "W", npm: "n", models: { m: { name: "M", output: 10 } } } },
    mimoWorkbuddyConnect: { version: 1 },
  };
  const problems = validateConfigDocument(bad);
  assert.ok(problems.some((p) => p.includes("mimoWorkbuddyConnect")), "should flag the root marker");
  assert.ok(problems.some((p) => p.includes('unknown key "output"')), "should flag output at model level");
});

await test("validation requires a complete limit object", () => {
  const doc = { provider: { workbuddy: { models: { m: { name: "M", limit: { context: 1000 } } } } } };
  const problems = validateConfigDocument(doc);
  assert.ok(problems.some((p) => p.includes('requires a numeric "output"')));
});

await test("writeConfig refuses a schema-invalid document", () => {
  const target = join(tmpdir(), `mwc-validate-${process.pid}.json`);
  assert.throws(() => writeConfig(target, { mimoWorkbuddyConnect: { version: 1 } }), /refusing to write/u);
  assert.equal(existsSync(target), false, "must not create the file");
});

await test("removeProviders cleans up a legacy root marker", () => {
  const block = buildProviderBlock({ port: 1, providerId: "workbuddy", displayName: "W", models: {} });
  const legacy = { provider: { workbuddy: block, other: { name: "Other" } }, mimoWorkbuddyConnect: { version: 1, providerIds: ["workbuddy"] }, model: "workbuddy/m" };
  const cleaned = removeProviders(legacy);
  assert.equal(cleaned.provider.workbuddy, undefined);
  assert.equal(cleaned.provider.other.name, "Other");
  assert.equal(cleaned.mimoWorkbuddyConnect, undefined);
  assert.equal(cleaned.model, undefined);
});

await test("a user's own provider is left alone by removeProviders", () => {
  // No sentinel key and not one of ours: it belongs to the user.
  const doc = { provider: { workbuddy: { name: "Mine", npm: "x", options: { baseURL: "http://example/v1", apiKey: "sk-user" } } } };
  const cleaned = removeProviders(doc);
  assert.equal(cleaned.provider.workbuddy.name, "Mine");
});

process.stdout.write("\nprovider config\n");

await test("parseJsonc strips comments and trailing commas but keeps URLs", () => {
  const parsed = JSON.parse(parseJsonc('{\n// c\n"a":1,\n"b":"http://x//y",\n"c":[1,2,],\n}'));
  assert.deepEqual(parsed, { a: 1, b: "http://x//y", c: [1, 2] });
});

await test("config dir follows the engine's own resolution order", () => {
  const saved = { home: process.env.MIMOCODE_HOME, xdg: process.env.XDG_CONFIG_HOME };
  try {
    delete process.env.MIMOCODE_HOME;
    delete process.env.XDG_CONFIG_HOME;
    // Must be ~/.config/mimocode, not %LOCALAPPDATA% — this is what Desktop uses.
    assert.match(globalConfigDir(), /[\\/]\.config[\\/]mimocode$/u);

    process.env.XDG_CONFIG_HOME = process.platform === "win32" ? "C:\\xdg" : "/xdg";
    assert.equal(globalConfigDir(), join("C:\\xdg", "mimocode").replace("C:\\xdg", process.platform === "win32" ? "C:\\xdg" : "/xdg"));

    process.env.MIMOCODE_HOME = process.platform === "win32" ? "C:\\mhome" : "/mhome";
    assert.match(globalConfigDir(), /[\\/]config$/u);
  } finally {
    for (const [key, value] of [["MIMOCODE_HOME", saved.home], ["XDG_CONFIG_HOME", saved.xdg]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

await test("applyProviders preserves unrelated config", () => {
  const block = buildProviderBlock({ port: 1234, providerId: "workbuddy", displayName: "WorkBuddy", models: { m: { name: "M" } } });
  const next = applyProviders({ theme: "dark", provider: { other: { name: "Other" } } }, { workbuddy: block }, "workbuddy/m");
  assert.equal(next.theme, "dark");
  assert.equal(next.provider.other.name, "Other");
  assert.equal(next.provider.workbuddy.options.baseURL, "http://127.0.0.1:1234/v1");
  assert.equal(next.provider.workbuddy.only_configured_models, true);
  assert.equal(next.model, "workbuddy/m");
  assert.equal(isManaged(next), true);
});

await test("removeProviders removes only our entries", () => {
  const block = buildProviderBlock({ port: 1, providerId: "workbuddy", displayName: "W", models: {} });
  const withOurs = applyProviders({ provider: { other: { name: "Other" } } }, { workbuddy: block }, "workbuddy/m");
  const cleaned = removeProviders(withOurs);
  assert.equal(cleaned.provider.workbuddy, undefined);
  assert.equal(cleaned.provider.other.name, "Other");
  assert.equal(cleaned.model, undefined);
  assert.equal(isManaged(cleaned), false);
});

process.stdout.write("\nupstream helpers\n");

await test("regionOf distinguishes the two products", () => {
  assert.equal(regionOf("www.codebuddy.cn"), "cn");
  assert.equal(regionOf(""), "cn");
  assert.equal(regionOf("workbuddy.ai"), "global");
  assert.equal(regionOf("eu.workbuddy.ai"), "global");
});

await test("classifyUpstreamError maps statuses and markers", () => {
  assert.equal(classifyUpstreamError(402, ""), "hard_credit");
  assert.equal(classifyUpstreamError(401, ""), "session_dead");
  assert.equal(classifyUpstreamError(429, ""), "soft_rate");
  assert.equal(classifyUpstreamError(500, ""), "server");
  assert.equal(classifyUpstreamError(200, "积分不足"), "hard_credit");
  assert.equal(classifyUpstreamError(200, "Offline user session not found"), "session_dead");
});

await test("extractDisplayErrorMessage prefers localized text", () => {
  assert.equal(extractDisplayErrorMessage('{"displayMsg":{"zh":"中文错","en":"english"}}'), "中文错");
  assert.equal(extractDisplayErrorMessage('{"displayMsg":{"en":"english"}}'), "english");
  assert.equal(extractDisplayErrorMessage('{"msg":"plain"}'), "plain");
  assert.equal(extractDisplayErrorMessage("not json"), undefined);
});

await test("prepareChatBody rewrites developer role and forces stream", () => {
  const out = prepareChatBody({ model: "m", stream: false, messages: [{ role: "developer", content: "sys" }, { role: "user", content: "hi" }] });
  assert.equal(out.stream, true);
  assert.equal(out.messages[0].role, "system");
  assert.equal(out.messages[1].role, "user");
});

await test("prepareChatBody flattens tool_choice and drops tools for none", () => {
  const named = prepareChatBody({ tool_choice: { type: "function", function: { name: "f" } }, tools: [] });
  assert.equal(named.tool_choice, "f");
  const auto = prepareChatBody({ tool_choice: { type: "auto" } });
  assert.equal(auto.tool_choice, "auto");
  const none = prepareChatBody({ tool_choice: "none", tools: [{ type: "function" }] });
  assert.equal(none.tool_choice, undefined);
  assert.equal(none.tools, undefined);
});

process.stdout.write("\nauth parsing\n");

await test("parseWorkBuddyAuth reads the nested shape", () => {
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: "tok", refreshToken: "ref", domain: "www.codebuddy.cn", expiresAt: 1893456000000 }, account: { uid: "u1", enterpriseId: "e1" } }));
  assert.equal(credential.accessToken, "tok");
  assert.equal(credential.refreshToken, "ref");
  assert.equal(credential.uid, "u1");
  assert.equal(credential.enterpriseId, "e1");
  assert.equal(credential.encrypted, false);
});

await test("parseWorkBuddyAuth normalizes second-based expiry", () => {
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: "t", expiresAt: 1893456000 } }));
  assert.equal(credential.expiresAtMs, 1893456000000);
});

await test("parseWorkBuddyAuth flags encrypted fields", () => {
  const credential = parseWorkBuddyAuth(JSON.stringify({ auth: { accessToken: { $wbEncrypted: 1, envelope: "x" } } }));
  assert.equal(credential.encrypted, true);
});

await test("classifyAuthDocument labels each shape", () => {
  assert.equal(classifyAuthDocument(""), "absent");
  assert.equal(classifyAuthDocument("nope"), "unrecognized");
  assert.equal(classifyAuthDocument('{"auth":{"accessToken":"x"}}'), "plaintext");
  assert.equal(classifyAuthDocument('{"auth":{"accessToken":{"$wbEncrypted":1,"envelope":"e"}}}'), "encrypted");
});

process.stdout.write("\nprotection\n");

await test("AAD framing matches the documented layout", () => {
  const aad = buildAuthenticatedContextAad("9127dea1b44020a7", 1);
  assert.equal(aad.subarray(0, 7).toString("ascii"), "WB-AAD\0");
  assert.equal(aad[7], 1);
  assert.equal(aad.readUInt32BE(8), 5);
  assert.equal(aad.subarray(12, 17).toString("utf8"), "WBEV1");
});

await test("parseWrappedField rejects malformed envelopes", () => {
  assert.equal(parseWrappedField(undefined), undefined);
  assert.equal(parseWrappedField({ $wbEncrypted: 1 }), undefined);
  assert.equal(parseWrappedField({ $wbEncrypted: 1, envelope: "!!!" }), undefined);
});

process.stdout.write("\nrelay server\n");

/** Minimal session/upstream doubles for the offline streaming test. */
function fakeDeps(sseChunks) {
  const encoder = new TextEncoder();
  const session = {
    credential: { accessToken: "x", refreshToken: "r", domain: "", uid: "u", expiresAtMs: 0 },
    lastError: undefined,
    async ensureCredential() {
      return true;
    },
    needsRefresh() {
      return false;
    },
    async refresh() {
      return true;
    },
    describe() {
      return { displayName: "WorkBuddy", signedIn: true, source: "test" };
    },
  };
  const upstream = {
    async chatStream() {
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return { ok: true, response: { body: stream } };
    },
  };
  return { session, upstream, getModels: () => [{ id: "m" }], log: () => {} };
}

await test("collects a streamed answer into one completion", async () => {
  const deps = fakeDeps([
    'data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"content":"Hel"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ]);
  const server = new RelayServer(deps);
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.choices[0].message.content, "Hello");
  assert.equal(payload.choices[0].finish_reason, "stop");
  assert.equal(payload.usage.completion_tokens, 2);
  await server.close();
});

await test("reassembles streamed tool call arguments", async () => {
  const deps = fakeDeps([
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const server = new RelayServer(deps);
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "read a.txt" }], tools: [{ type: "function", function: { name: "read" } }] }),
  });
  const payload = await response.json();
  const call = payload.choices[0].message.tool_calls[0];
  assert.equal(call.id, "call_1");
  assert.equal(call.function.name, "read");
  assert.deepEqual(JSON.parse(call.function.arguments), { path: "a.txt" });
  assert.equal(payload.choices[0].message.content, null);
  await server.close();
});

await test("captures reasoning_content as a separate field", async () => {
  const deps = fakeDeps([
    'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n\n',
    'data: {"choices":[{"index":0,"delta":{"content":"answer"}}]}\n\n',
    "data: [DONE]\n\n",
  ]);
  const server = new RelayServer(deps);
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "think then answer" }] }),
  });
  const payload = await response.json();
  assert.equal(payload.choices[0].message.content, "answer");
  assert.equal(payload.choices[0].message.reasoning_content, "think");
  await server.close();
});

await test("serves /health and /v1/models", async () => {
  const server = new RelayServer(fakeDeps([]));
  const port = await server.listen(0);
  const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
  assert.equal(health.ok, true);
  const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
  assert.deepEqual(models.data.map((m) => m.id), ["m"]);
  await server.close();
});

await test("returns a 404 for unknown routes", async () => {
  const server = new RelayServer(fakeDeps([]));
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/nope`);
  assert.equal(response.status, 404);
  await server.close();
});

await test("rejects an empty messages array", async () => {
  const server = new RelayServer(fakeDeps([]));
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [] }),
  });
  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.match(payload.error.message, /non-empty/);
  await server.close();
});

await test("resolveModel falls back for unknown names but passes known ones", () => {
  const models = [{ id: "default" }, { id: "deepseek-v4-pro" }, { id: "glm-5.3" }];
  const server = new RelayServer({ ...fakeDeps([]), getModels: () => models });
  assert.equal(server.resolveModel("glm-5.3"), "glm-5.3");
  assert.equal(server.resolveModel("gpt-4o"), "default");
  assert.equal(server.resolveModel(undefined), "default");
});

await test("resolveModel leaves the name untouched with no catalog", () => {
  const server = new RelayServer({ ...fakeDeps([]), getModels: () => [] });
  assert.equal(server.resolveModel("whatever"), "whatever");
});

await test("reports a 401 when not signed in", async () => {
  const deps = fakeDeps([]);
  deps.session.ensureCredential = async () => false;
  deps.session.lastError = "no WorkBuddy auth file found";
  const server = new RelayServer(deps);
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 401);
  const payload = await response.json();
  assert.equal(payload.error.code, "session_dead");
  await server.close();
});

await test("surfaces an upstream failure with a mapped status", async () => {
  const deps = fakeDeps([]);
  deps.upstream.chatStream = async () => ({ ok: false, status: 402, kind: "hard_credit", message: "积分不足" });
  const server = new RelayServer(deps);
  const port = await server.listen(0);
  const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(response.status, 402);
  const payload = await response.json();
  assert.equal(payload.error.message, "积分不足");
  await server.close();
});

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length > 0) {
  for (const { name, error } of failures) process.stdout.write(`\n${name}\n${error.stack}\n`);
  process.exit(1);
}
