// Verifies the running installed relay against the request shapes an
// OpenAI-compatible SDK (what MiMoCode uses) actually emits.
const BASE = process.env.RELAY ?? "http://127.0.0.1:8791";

const shapes = [
  [
    "stream_options",
    { model: "deepseek-v4-flash", messages: [{ role: "user", content: "say OK" }], stream: true, stream_options: { include_usage: true } },
  ],
  [
    "tool_choice required",
    {
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "weather in Paris?" }],
      tool_choice: "required",
      tools: [{ type: "function", function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
      stream: false,
    },
  ],
  ["empty messages", { model: "deepseek-v4-flash", messages: [], stream: false }],
  [
    "developer role",
    { model: "deepseek-v4-flash", messages: [{ role: "developer", content: "Be terse." }, { role: "user", content: "say OK" }], stream: false },
  ],
  [
    "unknown model falls back",
    { model: "gpt-4o", messages: [{ role: "user", content: "say OK" }], stream: false },
  ],
];

for (const [name, body] of shapes) {
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (body.stream) {
      const text = await response.text();
      console.log(name.padEnd(24), "HTTP", response.status, "sseDone=" + text.includes("data: [DONE]"), "bytes=" + text.length);
    } else {
      const payload = await response.json();
      const message = payload.choices?.[0]?.message;
      const summary = message?.tool_calls
        ? { tool: message.tool_calls[0].function.name, args: message.tool_calls[0].function.arguments }
        : { content: (message?.content ?? payload.error?.message ?? "").replace(/\s+/g, " ").slice(0, 60) };
      console.log(name.padEnd(24), "HTTP", response.status, JSON.stringify(summary));
    }
  } catch (error) {
    console.log(name.padEnd(24), "FAIL", error.message);
  }
}
