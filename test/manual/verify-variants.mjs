// Verifies that a variant's reasoningEffort actually reaches the upstream and
// changes model behaviour when sent through the configured relay.
import { readFileSync } from "node:fs";
import { parseJsonc } from "../../src/provider.js";

const configPath = process.env.USERPROFILE + "\\.config\\mimocode\\mimocode.jsonc";
const config = JSON.parse(parseJsonc(readFileSync(configPath, "utf8")));
const base = config.provider.workbuddy.options.baseURL;
console.log("relay:", base, "\n");

/** Send one request with a given effort and report reasoning volume. */
async function ask(model, reasoningEffort) {
  const body = {
    model,
    stream: true,
    max_tokens: 2048,
    messages: [{ role: "user", content: "What is 17 * 23? Think step by step." }],
  };
  if (reasoningEffort !== undefined) body.reasoning_effort = reasoningEffort;

  const response = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) return { ok: false, status: response.status };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reasoning = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const p = line.slice(5).trim();
        if (p === "" || p === "[DONE]") continue;
        try {
          const d = JSON.parse(p).choices?.[0]?.delta ?? {};
          if (d.reasoning_content) reasoning += d.reasoning_content.length;
          if (d.content) text += d.content;
        } catch {}
      }
    }
  }
  return { ok: true, reasoning, answer: text.trim().split("\n")[0].slice(0, 30) };
}

const model = process.argv[2] ?? "space-bunny";
const variants = Object.keys(config.provider.workbuddy.models[model]?.variants ?? {});
console.log(`model ${model} exposes: ${variants.join(", ") || "(none)"}\n`);

// Bare request first: the variant is what the user picks, so the baseline
// should differ from at least the extremes.
for (const effort of [undefined, ...variants]) {
  const r = await ask(model, effort);
  const label = (effort ?? "(base/default)").padEnd(16);
  console.log(r.ok ? `  ${label} reasoning=${String(r.reasoning).padStart(5)}  first-line=${JSON.stringify(r.answer)}` : `  ${label} HTTP ${r.status}`);
}
process.exit(0);
