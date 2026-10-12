/**
 * Local OpenAI-compatible relay that fronts the WorkBuddy upstream.
 *
 * MiMo Desktop runs MiMoCode on the Node runtime, where the `@mimo-ai/plugin`
 * SDK is not served, so a provider cannot be contributed in-process. Instead
 * MiMoCode consumes this relay through its ordinary declarative
 * `provider.<id>` configuration (see `provider.js`), which is the supported
 * path on Desktop.
 *
 * Endpoints:
 *   GET  /health              relay + credential state
 *   GET  /v1/models           model list (OpenAI shape)
 *   POST /v1/chat/completions OpenAI chat, streaming and non-streaming
 *
 * @module mimo-workbuddy-connect/server
 */
import { createServer } from "node:http";

const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade"]);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendOpenAIError(res, status, message, code) {
  sendJson(res, status, { error: { message, type: "upstream_error", code: code ?? "upstream_error" } });
}

/** Map a classified upstream failure to an HTTP status and message. */
function statusForKind(kind, upstreamStatus) {
  switch (kind) {
    case "hard_credit":
      return 402;
    case "session_dead":
      return 401;
    case "soft_rate":
      return 429;
    case "not_found":
      return 404;
    case "server":
      return 502;
    default:
      return upstreamStatus >= 400 && upstreamStatus < 500 ? upstreamStatus : 400;
  }
}

async function readJsonBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/**
 * Serve one variant over a loopback HTTP port.
 */
export class RelayServer {
  /**
   * @param {object} options
   * @param {import('./session.js').CredentialSession} options.session
   * @param {import('./upstream.js').WorkBuddyUpstreamClient} options.upstream
   * @param {() => Array<object>} options.getModels - current catalog.
   * @param {(message: string) => void} [options.log]
   */
  constructor({ session, upstream, getModels, log = () => {} }) {
    this.session = session;
    this.upstream = upstream;
    this.getModels = getModels;
    this.log = log;
    this.server = undefined;
    this.port = undefined;
  }

  /**
   * Start listening on a loopback port; resolves with the bound port.
   *
   * When `preferredPort` is taken, `fallbackToEphemeral` picks a free port
   * instead of failing. Callers that record the port in configuration pass
   * `false`, so a silent port change cannot leave a stale URL behind.
   */
  async listen(preferredPort = 0, { fallbackToEphemeral = true } = {}) {
    if (this.server !== undefined) return this.port;
    const start = async (port) => {
      const server = createServer((req, res) => {
        void this.handle(req, res).catch((error) => {
          this.log(`request failed: ${error.message}`);
          if (!res.headersSent) sendOpenAIError(res, 500, String(error.message));
          else res.end();
        });
      });
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, "127.0.0.1");
      });
      return server;
    };

    try {
      this.server = await start(preferredPort);
    } catch (error) {
      if (error.code !== "EADDRINUSE" || preferredPort === 0 || !fallbackToEphemeral) throw error;
      this.log(`port ${preferredPort} is in use; falling back to a free port`);
      this.server = await start(0);
    }

    this.port = this.server.address().port;
    this.log(`listening on http://127.0.0.1:${this.port}/v1`);
    return this.port;
  }

  async close() {
    if (this.server === undefined) return;
    await new Promise((resolve) => this.server.close(resolve));
    this.server = undefined;
  }

  /** Route one request. */
  async handle(req, res) {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port ?? 0}`);
    const path = url.pathname.replace(/\/+$/u, "") || "/";

    if (req.method === "GET" && (path === "/health" || path === "/v1/health")) {
      const models = this.safeModels();
      return sendJson(res, 200, {
        ok: true,
        service: "mimo-workbuddy-connect",
        ...this.session.describe(),
        models: models.length,
      });
    }

    if (req.method === "GET" && (path === "/v1/models" || path === "/models")) {
      return sendJson(res, 200, {
        object: "list",
        data: this.safeModels().map((model) => ({
          id: model.id,
          object: "model",
          created: 0,
          owned_by: "workbuddy",
        })),
      });
    }

    if (req.method === "POST" && (path === "/v1/chat/completions" || path === "/chat/completions")) {
      return this.chatCompletions(req, res);
    }

    sendOpenAIError(res, 404, `no route for ${req.method} ${path}`, "not_found");
  }

  /** Catalog access that never throws into a route. */
  safeModels() {
    try {
      return this.getModels() ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Map a requested model name onto one the account can actually use.
   *
   * A tool may send a name from another provider, or a name the roster has
   * since dropped. The upstream answers those with a hard 400, so a known
   * model is substituted instead — the same silent fallback the DSH plugin
   * applies. A name already in the catalog is passed through untouched.
   */
  resolveModel(requested) {
    const models = this.safeModels();
    if (models.length === 0) return requested;
    if (typeof requested === "string" && models.some((model) => model.id === requested)) {
      return requested;
    }
    // Prefer the catalog's own default row, then the first chat-capable model.
    const fallback =
      models.find((model) => model.id === "default") ??
      models.find((model) => model.id.startsWith("deepseek")) ??
      models[0];
    if (requested !== undefined && requested !== fallback.id) {
      this.log(`model "${requested}" is not in the catalog; using "${fallback.id}"`);
    }
    return fallback.id;
  }

  /** Proxy a chat completion, translating streaming SSE when requested. */
  async chatCompletions(req, res) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      return sendOpenAIError(res, 400, `invalid JSON body: ${error.message}`, "invalid_request");
    }

    if (!(await this.session.ensureCredential())) {
      return sendOpenAIError(
        res,
        401,
        this.session.lastError ?? "not signed in to the WorkBuddy app",
        "session_dead",
      );
    }
    if (this.session.needsRefresh()) await this.session.refresh().catch(() => {});

    if (!Array.isArray(body?.messages) || body.messages.length === 0) {
      return sendOpenAIError(
        res,
        400,
        "messages must be a non-empty array",
        "invalid_request",
      );
    }

    const wantsStream = body?.stream === true;
    // The upstream always streams; ask for it explicitly and adapt the framing.
    const upstreamBody = { ...body, stream: true, model: this.resolveModel(body?.model) };

    let attempt = await this.requestChat(upstreamBody);
    // A rejected session is the one failure worth retrying after a refresh.
    if (!attempt.ok && attempt.kind === "session_dead" && (await this.session.refresh())) {
      attempt = await this.requestChat(upstreamBody);
    }
    if (!attempt.ok) {
      return sendOpenAIError(
        res,
        statusForKind(attempt.kind, attempt.status),
        attempt.message ?? "upstream request failed",
        attempt.kind,
      );
    }

    if (wantsStream) return this.pipeStream(res, attempt.response, body?.model);
    return this.collectResponse(res, attempt.response, body?.model);
  }

  /** One upstream chat call via the shared client. */
  async requestChat(body) {
    return this.upstream.chatStream(this.session.credential, body);
  }

  /** Forward an upstream SSE stream, optionally re-framed as a single JSON. */
  async pipeStream(res, upstreamResponse, model) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const reader = upstreamResponse.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(Buffer.from(value))) {
          await new Promise((resolve) => res.once("drain", resolve));
        }
      }
    } catch (error) {
      this.log(`stream aborted: ${error.message}`);
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
      res.end();
    }
  }

  /**
   * Drain an upstream SSE stream into one non-streaming completion.
   *
   * Content and tool calls are accumulated by index so a multi-chunk tool
   * argument payload reassembles correctly.
   */
  async collectResponse(res, upstreamResponse, requestedModel) {
    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let id = `chatcmpl-${Date.now().toString(36)}`;
    let model = requestedModel ?? "workbuddy";
    let created = Math.floor(Date.now() / 1000);
    let content = "";
    let reasoning = "";
    let finishReason = null;
    let usage;
    /** @type {Map<number, {id: string, name: string, args: string}>} */
    const toolCalls = new Map();

    const applyChunk = (chunk) => {
      if (chunk?.id) id = chunk.id;
      if (chunk?.model) model = chunk.model;
      if (typeof chunk?.created === "number") created = chunk.created;
      if (chunk?.usage) usage = chunk.usage;
      const choice = chunk?.choices?.[0];
      if (choice === undefined) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.content === "string") content += delta.content;
      if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls ?? []) {
        const index = typeof call.index === "number" ? call.index : toolCalls.size;
        const existing = toolCalls.get(index) ?? { id: "", name: "", args: "" };
        if (call.id) existing.id = call.id;
        if (call.function?.name) existing.name += call.function.name;
        if (call.function?.arguments) existing.args += call.function.arguments;
        toolCalls.set(index, existing);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE events are separated by a blank line; keep the trailing partial.
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          for (const line of event.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "" || payload === "[DONE]") continue;
            try {
              applyChunk(JSON.parse(payload));
            } catch {
              /* ignore a malformed event rather than failing the answer */
            }
          }
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }

    const message = { role: "assistant", content: content === "" && toolCalls.size > 0 ? null : content };
    if (reasoning !== "") message.reasoning_content = reasoning;
    if (toolCalls.size > 0) {
      message.tool_calls = [...toolCalls.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, call]) => ({
          id: call.id || `call_${Math.random().toString(36).slice(2, 10)}`,
          type: "function",
          function: { name: call.name, arguments: call.args === "" ? "{}" : call.args },
        }));
    }

    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message, finish_reason: finishReason ?? "stop" }],
      ...(usage === undefined ? {} : { usage }),
    });
  }
}

export const internals = { statusForKind, readJsonBody, HOP_BY_HOP };
