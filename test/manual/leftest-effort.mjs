// Confirms the upstream really honours reasoning_effort, and that the effort
// levels we expose as variants are accepted (not silently ignored).
import { WorkBuddyUpstreamClient } from "../../src/upstream.js";
import { CredentialSession, VARIANTS } from "../../src/index.js";

const upstream = new WorkBuddyUpstreamClient();
const session = new CredentialSession({ variant: VARIANTS.cn, upstream, log: () => {} });
if (!(await session.ensureCredential())) {
  console.log("not signed in");
  process.exit(1);
}

/** Stream one request and report whether reasoning content came back. */
async function probe(model, effort) {
  const body = {
    model,
    stream: true,
    max_tokens: 2048,
    messages: [{ role: "user", content: "What is 17 * 23? Think step by step, then give the number." }],
  };
  if (effort !== undefined) body.reasoning_effort = effort;

  const result = await upstream.chatStream(session.credential, body);
  if (!result.ok) return { effort, ok: false, status: result.status, message: result.message };

  const reader = result.response.body.getReader();
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
        const payload = line.slice(5).trim();
        if (payload === "" || payload === "[DONE]") continue;
        try {
          const chunk = JSON.parse(payload);
          const delta = chunk.choices?.[0]?.delta ?? {};
          if (delta.reasoning_content) reasoning += delta.reasoning_content.length;
          if (delta.content) text += delta.content;
        } catch {}
      }
    }
  }
  return { effort, ok: true, reasoningChars: reasoning, answer: text.trim().slice(0, 40) };
}

const model = process.argv[2] ?? "deepseek-v4.1-flash";
console.log(`model: ${model}\n`);
for (const effort of [undefined, "low", "high", "max", "bogus-value"]) {
  const r = await probe(model, effort);
  const label = effort ?? "(default)";
  if (!r.ok) console.log(`  ${label.padEnd(12)} FAILED ${r.status}: ${String(r.message).slice(0, 60)}`);
  else console.log(`  ${label.padEnd(12)} reasoning=${String(r.reasoningChars).padStart(5)} chars  answer=${JSON.stringify(r.answer)}`);
}
process.exit(0);
