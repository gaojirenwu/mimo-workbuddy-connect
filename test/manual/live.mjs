// Live end-to-end test: read the real encrypted credential, fetch the real
// catalog, start the relay, and make one real chat request through it.
import { startAll } from "../../src/index.js";

const runtimes = await startAll({
  variants: ["cn"],
  port: 0,
  log: (m) => console.log("[log] " + m),
});

for (const runtime of runtimes) {
  const status = runtime.describe();
  console.log("\n=== " + status.displayName + " ===");
  console.log("signedIn   :", status.signedIn, "(source=" + status.source + ")");
  console.log("account    :", status.account);
  console.log("domain     :", status.domain);
  console.log("relay port :", status.port);
  console.log("models     :", status.models, "(source=" + status.catalogSource + ")");
  if (status.catalogError) console.log("catalogErr :", status.catalogError);
  console.log("\nmodel ids:");
  for (const model of runtime.models.slice(0, 40)) {
    const bits = [];
    if (model.contextWindow) bits.push("ctx=" + model.contextWindow);
    if (model.supportsImages) bits.push("img");
    if (model.billing?.credits) bits.push(model.billing.credits);
    console.log("  - " + model.id + "  [" + model.name + "] " + bits.join(" "));
  }
}

// Probe /health and /v1/models through the relay.
const port = runtimes[0].port;
const health = await (await fetch(`http://127.0.0.1:${port}/health`)).json();
console.log("\n/health ok:", health.ok, "models:", health.models);
const models = await (await fetch(`http://127.0.0.1:${port}/v1/models`)).json();
console.log("/v1/models count:", models.data.length);

// One real chat completion through the relay.
const target = runtimes[0].models.find((m) => m.reasoning?.supports) ?? runtimes[0].models[0];
console.log("\n=== live chat via relay, model=" + target.id + " ===");
const started = Date.now();
const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: target.id,
    messages: [{ role: "user", content: "Reply with exactly: CONNECT_OK" }],
    stream: false,
  }),
});
const payload = await response.json();
console.log("HTTP", response.status, `(${Date.now() - started}ms)`);
if (payload.error) {
  console.log("ERROR:", JSON.stringify(payload.error));
} else {
  const choice = payload.choices?.[0];
  console.log("content  :", JSON.stringify(choice?.message?.content));
  console.log("finish   :", choice?.finish_reason);
  console.log("usage    :", JSON.stringify(payload.usage));
}

for (const runtime of runtimes) await runtime.stop();
process.exit(0);
