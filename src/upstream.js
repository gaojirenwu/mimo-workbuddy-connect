/**
 * WorkBuddy upstream client: model catalog, chat streaming, token refresh and
 * credit balance.
 *
 * Wire behavior ported from `dsh-workbuddy-connect`'s `upstream.ts`, itself
 * ported from Sliverkiss/workbuddy2api (MIT), whose Go implementation is
 * battle-tested against the real endpoints.
 *
 * @module mimo-workbuddy-connect/upstream
 */
import { parseModelCatalog } from "./catalog.js";

export const CN_CHAT_BASE = "https://copilot.tencent.com";
export const CN_BILLING_BASE = "https://www.codebuddy.cn";
export const GLOBAL_BASE = "https://www.workbuddy.ai";

/** Shared CLI-form User-Agent for refresh and the CN catalog. */
const CLIENT_UA = "CLI/2.63.2 CodeBuddy/2.63.2";
const JSON_TIMEOUT_MS = 30_000;
const ERROR_BODY_LIMIT = 4096;

/** Insufficient-credit markers, ASCII lowercase plus the original Chinese. */
const HARD_CREDIT_MARKERS = [
  "insufficient credit",
  "no credit",
  "credit exhausted",
  "credits exhausted",
  "out of credit",
  "quota exceeded",
  "quota exhaust",
  "payment required",
  "credit not enough",
  "not enough credit",
  "积分不足",
  "额度不足",
  "余额不足",
  "积分用完",
  "额度用尽",
  "没有积分",
];

/** Session-invalidation markers that mean "sign in again in the app". */
const SESSION_DEAD_MARKERS = ["Offline user session not found", "12153"];

/** Region for a login domain; an empty domain means CN. */
export function regionOf(domain) {
  const lowered = String(domain ?? "").trim().toLowerCase();
  if (lowered === "workbuddy.ai" || lowered.endsWith(".workbuddy.ai")) return "global";
  return "cn";
}

export function chatBase(credential) {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_CHAT_BASE;
}
export function billingBase(credential) {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}
export function originReferer(credential) {
  return regionOf(credential.domain) === "global" ? GLOBAL_BASE : CN_BILLING_BASE;
}

/** Classify an upstream failure from its HTTP status and body excerpt. */
export function classifyUpstreamError(status, body) {
  if (status === 402) return "hard_credit";
  if (status === 401) return "session_dead";
  const lower = String(body ?? "").toLowerCase();
  for (const marker of HARD_CREDIT_MARKERS) {
    if (lower.includes(marker.toLowerCase()) || String(body).includes(marker)) return "hard_credit";
  }
  for (const marker of SESSION_DEAD_MARKERS) {
    if (String(body).includes(marker)) return "session_dead";
  }
  if (status === 429) return "soft_rate";
  if (status === 404) return "not_found";
  if (status >= 500) return "server";
  return "client";
}

/** Extract a user-facing message from an upstream JSON body. */
export function extractDisplayErrorMessage(body) {
  const trimmed = String(body ?? "").trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const displayMsg = parsed["displayMsg"];
    if (typeof displayMsg === "object" && displayMsg !== null && !Array.isArray(displayMsg)) {
      if (typeof displayMsg["zh"] === "string" && displayMsg["zh"].trim() !== "") {
        return displayMsg["zh"].trim();
      }
      if (typeof displayMsg["en"] === "string" && displayMsg["en"].trim() !== "") {
        return displayMsg["en"].trim();
      }
    }
    if (typeof parsed["msg"] === "string" && parsed["msg"].trim() !== "") {
      return parsed["msg"].trim();
    }
  } catch {
    /* fall through */
  }
  return undefined;
}

/** Headers every upstream request shares. */
function commonHeaders(credential) {
  return {
    Accept: "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    Origin: originReferer(credential),
    Referer: `${originReferer(credential)}/`,
    "User-Agent": CLIENT_UA,
  };
}

/**
 * Chat request headers, including the `X-No-*` conventions the official CLI
 * uses. `clientVersion` also feeds `X-IDE-Version`.
 */
function chatHeaders(credential, clientVersion) {
  return {
    ...commonHeaders(credential),
    "User-Agent": chatUserAgent(clientVersion),
    "Content-Type": "application/json",
    ...(credential.uid === "" ? { "X-No-User-Id": "1" } : { "X-User-Id": credential.uid }),
    ...(credential.enterpriseId === undefined || credential.enterpriseId === ""
      ? { "X-No-Enterprise-Id": "1" }
      : { "X-Enterprise-Id": credential.enterpriseId }),
    ...(credential.domain === "" ? { "X-No-Department-Info": "1" } : { "X-Domain": credential.domain }),
    "X-IDE-Type": "WorkBuddy",
    "X-IDE-Name": "WorkBuddy",
    "X-IDE-Version": clientVersion,
    "X-Product": "SaaS",
  };
}

/** The desktop-shaped chat User-Agent the gateway expects. */
export function chatUserAgent(clientVersion) {
  return `WorkBuddy/${clientVersion} WorkBuddy/${clientVersion}`;
}

/** Refresh-endpoint headers; `X-Refresh-Token` appears here and nowhere else. */
function refreshHeaders(credential) {
  const headers = {
    ...commonHeaders(credential),
    "X-Refresh-Token": credential.refreshToken,
    "X-Auth-Refresh-Source": "workbuddy",
  };
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
  }
  return headers;
}

/** Billing request headers. */
function billingHeaders(credential) {
  const headers = {
    Authorization: `Bearer ${credential.accessToken}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (credential.uid !== "") headers["X-User-Id"] = credential.uid;
  if (credential.enterpriseId !== undefined && credential.enterpriseId !== "") {
    headers["X-Enterprise-Id"] = credential.enterpriseId;
    headers["X-Tenant-Id"] = credential.enterpriseId;
  }
  if (credential.domain !== "") headers["X-Domain"] = credential.domain;
  return headers;
}

/** Read a JSON envelope, tolerating non-JSON bodies. */
async function readEnvelope(response) {
  const text = await response.text();
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    document = undefined;
  }
  const code = typeof document?.code === "number" ? document.code : response.ok ? 0 : -1;
  return { code, data: document?.data, document, text };
}

/**
 * Normalize an OpenAI chat-completions body for the WorkBuddy upstream: force
 * `stream: true` (the upstream rejects non-streaming), flatten `tool_choice`
 * (object forms return 400), and rewrite `developer` messages as `system`.
 *
 * The `developer` rewrite is load-bearing: MiMoCode emits the system prompt as
 * `role: "developer"`, but the upstream rejects that role with HTTP 400 code
 * 11128 ("Illegal API invocation from an unapproved channel").
 */
export function prepareChatBody(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return body;
  const obj = { ...body };
  obj["stream"] = true;

  const messages = obj["messages"];
  if (Array.isArray(messages)) {
    obj["messages"] = messages.map((message) => {
      if (typeof message !== "object" || message === null || Array.isArray(message)) return message;
      if (message["role"] === "developer") return { ...message, role: "system" };
      return message;
    });
  }

  normalizeToolChoice(obj);
  return obj;
}

/** Rewrite OpenAI `tool_choice` spellings into the upstream's string form. */
function normalizeToolChoice(obj) {
  const suppress = () => {
    delete obj["tools"];
    delete obj["functions"];
  };
  if (!("tool_choice" in obj)) return;
  const choice = obj["tool_choice"];
  if (typeof choice === "string") {
    if (choice.trim().toLowerCase() === "none") {
      delete obj["tool_choice"];
      suppress();
    }
    return;
  }
  if (typeof choice === "object" && choice !== null && !Array.isArray(choice)) {
    const type = typeof choice["type"] === "string" ? choice["type"].trim().toLowerCase() : "";
    if (type === "none") {
      delete obj["tool_choice"];
      suppress();
    } else if (type === "auto" || type === "required") {
      obj["tool_choice"] = type;
    } else if (type === "function") {
      const fn = typeof choice["function"] === "object" && choice["function"] !== null ? choice["function"] : undefined;
      let name = typeof fn?.["name"] === "string" ? fn["name"] : "";
      if (name === "" && typeof choice["name"] === "string") name = choice["name"];
      name = name.trim();
      obj["tool_choice"] = name === "" ? "auto" : name;
    }
  }
}

/**
 * Client for the WorkBuddy upstream. The caller owns credential refresh
 * bookkeeping; this class performs requests and reports classified failures.
 */
export class WorkBuddyUpstreamClient {
  constructor(options = {}) {
    this.clientVersion = options.clientVersion ?? "2.63.2";
  }

  /** POST the chat endpoint; a successful answer is the raw SSE response. */
  async chatStream(credential, body, signal) {
    const region = regionOf(credential.domain);
    let response;
    try {
      response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
        method: "POST",
        headers: {
          ...chatHeaders(credential, this.clientVersion),
          Authorization: `Bearer ${credential.accessToken}`,
        },
        body: JSON.stringify(prepareChatBody(body)),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return { ok: false, status: 0, kind: "server", message: `transport error: ${String(error)}` };
    }
    if (response.ok) return { ok: true, response };
    const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
    return {
      ok: false,
      status: response.status,
      kind: classifyUpstreamError(response.status, text),
      message: extractDisplayErrorMessage(text) ?? text,
    };
  }

  /** POST the token-refresh endpoint; the caller merges the outcome. */
  async refreshToken(credential) {
    const response = await fetch(`${chatBase(credential)}/v2/plugin/auth/token/refresh`, {
      method: "POST",
      headers: refreshHeaders(credential),
      signal: AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) {
      throw new Error(
        extractDisplayErrorMessage(envelope.text) ??
          `token refresh failed with HTTP ${response.status}`,
      );
    }
    const data = typeof envelope.data === "object" && envelope.data !== null ? envelope.data : {};
    const accessToken = typeof data["accessToken"] === "string" ? data["accessToken"] : "";
    if (accessToken === "") {
      throw new Error("token refresh returned no accessToken; sign in again in the WorkBuddy app");
    }
    const outcome = { accessToken };
    if (typeof data["refreshToken"] === "string" && data["refreshToken"] !== "") {
      outcome.refreshToken = data["refreshToken"];
    }
    if (typeof data["expiresIn"] === "number" && data["expiresIn"] > 0) {
      outcome.expiresInSec = data["expiresIn"];
    }
    if (typeof data["domain"] === "string" && data["domain"] !== "") outcome.domain = data["domain"];
    return outcome;
  }

  /**
   * GET the model catalog from `/v3/config`, the product document the desktop
   * app itself fetches. The gateway splits this document by client identity,
   * so the CLI-shaped User-Agent is load-bearing: it yields the chat roster
   * these requests can actually use.
   */
  async fetchModels(credential, signal = undefined) {
    const international = regionOf(credential.domain) === "global";
    const response = await fetch(`${chatBase(credential)}/v3/config`, {
      headers: {
        Authorization: `Bearer ${credential.accessToken}`,
        Accept: "application/json",
        Origin: originReferer(credential),
        Referer: `${originReferer(credential)}/`,
        ...(international ? { "X-Requested-With": "XMLHttpRequest", "X-Product": "SaaS" } : {}),
        "User-Agent": CLIENT_UA,
      },
      signal:
        signal === undefined
          ? AbortSignal.timeout(JSON_TIMEOUT_MS)
          : AbortSignal.any([signal, AbortSignal.timeout(JSON_TIMEOUT_MS)]),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) {
      const message = extractDisplayErrorMessage(envelope.text);
      const error = new Error(message ?? `catalog request failed with HTTP ${response.status}`);
      error.kind = classifyUpstreamError(response.status, envelope.text);
      throw error;
    }
    const source =
      typeof envelope.data === "object" && envelope.data !== null
        ? envelope.data
        : "models" in (envelope.document ?? {}) || "agents" in (envelope.document ?? {})
          ? envelope.document
          : {};
    return parseModelCatalog(source, international);
  }

  /** GET the account's remaining credit, for the status surface. */
  async fetchCredits(credential, signal = undefined) {
    const response = await fetch(`${billingBase(credential)}/v2/billing/meter/get-user-resource`, {
      method: "POST",
      headers: billingHeaders(credential),
      signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
    });
    const envelope = await readEnvelope(response);
    if (!response.ok || envelope.code !== 0) {
      throw new Error(
        extractDisplayErrorMessage(envelope.text) ??
          `billing request failed with HTTP ${response.status}`,
      );
    }
    return envelope.data;
  }

  /**
   * Ask the upstream whether it accepts one reasoning effort for a model.
   *
   * Most models do not declare their effort levels, but the chat endpoint
   * validates `reasoning_effort` and answers an unsupported value with HTTP 400
   * ("模型不支持该思考强度"). Sending the value is therefore the only reliable way
   * to discover what a model accepts.
   *
   * `max_tokens: 1` keeps the cost of the check negligible and the body is never
   * read past the first event; the caller only learns accept/reject.
   *
   * An inconclusive answer is retried, because a transient timeout is easy to
   * mistake for a rejection. Only an explicit 4xx naming the effort counts as
   * "rejected"; anything still ambiguous after the retries stays `inconclusive`
   * so the caller can leave the effort out rather than hide a working level.
   *
   * @returns {Promise<"accepted"|"rejected"|"unavailable"|"inconclusive">}
   */
  async probeEffort(credential, model, effort, { attempts = 3, signal = undefined } = {}) {
    const payload = {
      model,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
    };
    if (effort !== undefined) payload["reasoning_effort"] = effort;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      let response;
      try {
        response = await fetch(`${chatBase(credential)}/v2/chat/completions`, {
          method: "POST",
          headers: {
            ...chatHeaders(credential, this.clientVersion),
            Authorization: `Bearer ${credential.accessToken}`,
          },
          body: JSON.stringify(payload),
          signal: signal ?? AbortSignal.timeout(JSON_TIMEOUT_MS),
        });
      } catch {
        continue; // transport failure: retry, never "rejected"
      }

      if (response.ok) {
        // Reading one event proves the request was accepted rather than queued.
        try {
          const reader = response.body.getReader();
          await reader.read();
          await reader.cancel();
        } catch {
          /* a body we cannot read still means the status was 200 */
        }
        return "accepted";
      }

      const text = (await response.text()).slice(0, ERROR_BODY_LIMIT);
      const message = extractDisplayErrorMessage(text) ?? text;

      // The catalog can list models the account cannot actually call. That is a
      // property of the model, not of the effort, and is worth reporting apart
      // from an effort rejection so the cause is not misread.
      if (/模型不可用|model (is )?(not available|unavailable)/iu.test(message)) return "unavailable";

      // Only a 4xx naming the effort speaks to effort support; auth, quota and
      // server failures say nothing about it.
      if (response.status >= 400 && response.status < 500) {
        if (/思考强度|reasoning[_ ]effort|effort/iu.test(message)) return "rejected";
      }
    }
    return "inconclusive";
  }
}
