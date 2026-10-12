// Live streaming + tool-call test through the relay against the real account.
import { startAll } from "../../src/index.js";

const runtimes = await startAll({ variants: ["cn"], port: 0, log: () => {} });
const runtime = runtimes[0];
const port = runtime.port;
const target = runtime.models.find((m) => m.id === "deepseek-v4-flash") ?? runtime.models[0];
console.log("streaming model:", target.id);

// 1. Streaming: confirm real SSE frames arrive incrementally.
const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: target.id,
    messages: [{ role: "user", content: "Count from 1 to 5, one number per line." }],
    stream: true,
  }),
});
console.log("HTTP", response.status, "content-type:", response.headers.get("content-type"));

const reader = response.body.getReader();
const decoder = new TextDecoder();
let frames = 0;
let text = "";
let buffer = "";
let firstFrameAt = 0;
const started = Date.now();
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstFrameAt === 0) firstFrameAt = Date.now() - started;
  buffer += decoder.decode(value, { stream: true });
  let i;
  while ((i = buffer.indexOf("\n\n")) !== -1) {
    const event = buffer.slice(0, i);
    buffer = buffer.slice(i + 2);
    for (const line of event.split("\n")) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "" || payload === "[DONE]") continue;
      frames += 1;
      try {
        const chunk = JSON.parse(payload);
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) text += delta.content;
      } catch {}
    }
  }
}
console.log(`frames=${frames} firstFrame=${firstFrameAt}ms total=${Date.now() - started}ms`);
console.log("streamed text:", JSON.stringify(text.trim()));

// 2. Tool calling: confirm the tool path survives the transform.
console.log("\ntool-call test:");
const toolResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: target.id,
    messages: [{ role: "user", content: "What is the weather in Beijing? Use the tool." }],
    tools: [
      {
        type: "function",
        function: {
          name: "get_weather",
          description: "Get the weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      },
    ],
    stream: false,
  }),
});
const toolPayload = await toolResponse.json();
const message = toolPayload.choices?.[0]?.message;
console.log("HTTP", toolResponse.status);
console.log("tool_calls:", JSON.stringify(message?.tool_calls ?? null));
console.log("content:", JSON.stringify(message?.content ?? null));

// 3. Multi-turn: confirm an assistant tool_call round-trips.
if (message?.tool_calls?.length) {
  const followUp = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: target.id,
      messages: [
        { role: "user", content: "What is the weather in Beijing? Use the tool." },
        message,
        { role: "tool", tool_call_id: message.tool_calls[0].id, content: "Sunny, 24C" },
      ],
      stream: false,
    }),
  });
  const followPayload = await followUp.json();
  console.log("follow-up HTTP", followUp.status);
  console.log("follow-up content:", JSON.stringify(followPayload.choices?.[0]?.message?.content ?? followPayload.error));
}

// 4. Image understanding: confirm multimodal parts reach the model.
console.log("\nimage test:");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const visionModel = runtime.models.find((m) => m.supportsImages && m.id === "glm-5.3-flash") ?? runtime.models.find((m) => m.supportsImages);
const imageResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: visionModel.id,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What color is this single-pixel image? Answer in one word." },
          { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
        ],
      },
    ],
    stream: false,
  }),
});
const imagePayload = await imageResponse.json();
console.log("vision model:", visionModel.id, "HTTP", imageResponse.status);
console.log("content:", JSON.stringify(imagePayload.choices?.[0]?.message?.content ?? imagePayload.error));

for (const r of runtimes) await r.stop();
process.exit(0);
