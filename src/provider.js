/**
 * MiMoCode provider configuration.
 *
 * MiMo Desktop's core engine is MiMoCode (an OpenCode fork). It reads a
 * declarative `provider.<id>` block from `mimocode.json`, and on the Node
 * runtime Desktop uses, that declarative path is the supported way to add a
 * model source: the `@mimo-ai/plugin` SDK is only served on Bun, so an
 * in-process provider plugin cannot load there.
 *
 * This module writes and removes that block, pointing it at the local relay.
 *
 * @module mimo-workbuddy-connect/provider
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

/** Provider id used inside MiMoCode configuration. */
export const PROVIDER_ID = "workbuddy";
export const PROVIDER_ID_AI = "workbuddy-ai";

/**
 * Fixed loopback ports for each variant.
 *
 * The port must be stable: MiMoCode's configuration records the relay URL, so a
 * port that changed per run would leave every generated config pointing at a
 * dead endpoint. The two variants sit on adjacent ports so both can run at once.
 */
export const DEFAULT_PORTS = { cn: 8791, ai: 8792 };

/** Placeholder key MiMoCode requires to be non-empty; also marks our blocks. */
export const RELAY_API_KEY = "workbuddy-local";

/** Preferred port for a provider id. */
export function portForProvider(providerId) {
  return providerId === PROVIDER_ID_AI ? DEFAULT_PORTS.ai : DEFAULT_PORTS.cn;
}

/**
 * Marker for configuration we own.
 *
 * Deliberately NOT a top-level key: MiMoCode's schema declares
 * `additionalProperties: false` at the root, so any unknown top-level key makes
 * the whole file invalid and the app refuses to load it. Ownership is recorded
 * *inside* our own provider block instead, which the schema permits.
 */
const MANAGED_KEY = "mimoWorkbuddyConnect";
const MANAGED_VERSION = 1;

/** Keys the provider schema accepts; anything else invalidates the file. */
const ALLOWED_PROVIDER_KEYS = new Set([
  "api",
  "name",
  "env",
  "id",
  "npm",
  "whitelist",
  "blacklist",
  "options",
  "models",
  "only_configured_models",
]);

/** Keys the per-model schema accepts. */
const ALLOWED_MODEL_KEYS = new Set([
  "id",
  "name",
  "family",
  "release_date",
  "attachment",
  "reasoning",
  "temperature",
  "tool_call",
  "interleaved",
  "cost",
  "limit",
  "modalities",
  "experimental",
  "status",
  "cachePromptTTL",
  "provider",
  "options",
  "headers",
  "variants",
]);

/** Keys `limit` accepts; `context` and `output` are both required. */
const ALLOWED_LIMIT_KEYS = new Set(["context", "input", "output"]);

/** Keys provider-level `options` accepts. */
const ALLOWED_OPTION_KEYS = new Set([
  "apiKey",
  "baseURL",
  "enterpriseUrl",
  "setCacheKey",
  "timeout",
  "headerTimeout",
  "chunkTimeout",
]);

/** Top-level keys the config schema accepts. */
const ALLOWED_ROOT_KEYS = new Set([
  "$schema",
  "logLevel",
  "server",
  "command",
  "skills",
  "compose",
  "watcher",
  "snapshot",
  "plugin",
  "share",
  "autoshare",
  "autoupdate",
  "disabled_providers",
  "enabled_providers",
  "model",
  "small_model",
  "vision_model",
  "model_groups",
  "default_agent",
  "username",
  "mode",
  "agent",
  "provider",
  "mcp",
  "formatter",
  "lsp",
  "instructions",
  "layout",
  "permission",
  "tools",
  "tool",
  "enterprise",
  "compaction",
  "checkpoint",
  "memory",
  "history",
  "dream",
  "distill",
  "voice",
  "experimental",
  "workflow",
]);

/**
 * Check a document against the parts of MiMoCode's schema that reject unknown
 * keys, returning human-readable problems.
 *
 * MiMoCode validates with `additionalProperties: false` at the root, provider
 * and model levels, so an unknown key does not merely get ignored — it makes the
 * whole configuration invalid and the app refuses to load it with a message like
 * "配置文件有误". Generating config without this check is how a working relay
 * ends up reported as a broken file.
 *
 * @param {object} document - full config document.
 * @returns {string[]} problems; empty means the document is acceptable.
 */
export function validateConfigDocument(document) {
  const problems = [];
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return ["configuration root must be an object"];
  }

  for (const key of Object.keys(document)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      problems.push(`unknown top-level key "${key}" (the schema allows no additional properties)`);
    }
  }

  const providers = document["provider"];
  if (providers === undefined) return problems;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) {
    problems.push('"provider" must be an object');
    return problems;
  }

  for (const [id, block] of Object.entries(providers)) {
    if (typeof block !== "object" || block === null || Array.isArray(block)) {
      problems.push(`provider "${id}" must be an object`);
      continue;
    }
    for (const key of Object.keys(block)) {
      if (!ALLOWED_PROVIDER_KEYS.has(key)) {
        problems.push(`provider "${id}" has unknown key "${key}"`);
      }
    }
    const options = block["options"];
    if (options !== undefined && typeof options === "object" && options !== null) {
      for (const key of Object.keys(options)) {
        if (!ALLOWED_OPTION_KEYS.has(key)) {
          problems.push(`provider "${id}".options has unknown key "${key}"`);
        }
      }
    }
    const models = block["models"];
    if (models === undefined) continue;
    if (typeof models !== "object" || models === null || Array.isArray(models)) {
      problems.push(`provider "${id}".models must be an object`);
      continue;
    }
    for (const [modelId, model] of Object.entries(models)) {
      if (typeof model !== "object" || model === null || Array.isArray(model)) {
        problems.push(`provider "${id}" model "${modelId}" must be an object`);
        continue;
      }
      for (const key of Object.keys(model)) {
        if (!ALLOWED_MODEL_KEYS.has(key)) {
          problems.push(
            `provider "${id}" model "${modelId}" has unknown key "${key}"` +
              (key === "output" ? " (output belongs inside limit)" : ""),
          );
        }
      }
      const limit = model["limit"];
      if (limit === undefined) continue;
      if (typeof limit !== "object" || limit === null || Array.isArray(limit)) {
        problems.push(`provider "${id}" model "${modelId}".limit must be an object`);
        continue;
      }
      for (const key of Object.keys(limit)) {
        if (!ALLOWED_LIMIT_KEYS.has(key)) {
          problems.push(`provider "${id}" model "${modelId}".limit has unknown key "${key}"`);
        }
      }
      // The schema marks both of these as required.
      if (typeof limit["context"] !== "number") {
        problems.push(`provider "${id}" model "${modelId}".limit requires a numeric "context"`);
      }
      if (typeof limit["output"] !== "number") {
        problems.push(`provider "${id}" model "${modelId}".limit requires a numeric "output"`);
      }
    }
  }
  return problems;
}

/** Read the managed marker from inside our own provider block. */
export function managedMarkerOf(document) {
  const marker = document?.provider?.[PROVIDER_ID]?.[MANAGED_KEY];
  return marker?.version === MANAGED_VERSION ? marker : undefined;
}

/**
 * MiMoCode's global config directory.
 *
 * Transcribed from the engine's own resolver (verified against MiMo Desktop
 * 26.1010):
 *
 *     MIMOCODE_HOME (must be absolute) -> <home>/config
 *     else XDG_CONFIG_HOME             -> <xdg>/mimocode
 *     else                                 <homedir>/.config/mimocode
 *
 * Note this is `.config` on Windows too — *not* `%LOCALAPPDATA%`. MiMo Desktop
 * seeds and manages exactly this directory (it writes `mimocode.jsonc` there and
 * npm-installs `@mimo-ai/plugin` beside it), so writing anywhere else produces a
 * config the app never reads.
 */
export function globalConfigDir() {
  const override = process.env["MIMOCODE_HOME"]?.trim();
  if (override && isAbsolute(override)) return join(override, "config");

  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  if (xdg && isAbsolute(xdg)) return join(xdg, "mimocode");

  return join(homedir(), ".config", "mimocode");
}

/** Candidate filenames in the engine's own precedence order. */
export const CONFIG_FILENAMES = ["mimocode.jsonc", "mimocode.json", "config.json"];

/**
 * MiMoCode's global config locations, in the order the engine reads them.
 *
 * `MIMOCODE_CONFIG_DIR` is an *additional* search root the desktop sets to its
 * own `engine-config` (which holds the app's built-in tools plugin); it is
 * included so diagnostics can see it, but the user configuration the engine
 * seeds and merges lives in {@link globalConfigDir}.
 */
export function globalConfigCandidates() {
  const bases = [globalConfigDir()];
  const extra = process.env["MIMOCODE_CONFIG_DIR"]?.trim();
  if (extra && isAbsolute(extra)) bases.push(extra);
  return bases.flatMap((base) => CONFIG_FILENAMES.map((name) => join(base, name)));
}

/** The config file to write: an existing one if present, else the first candidate. */
export function resolveConfigPath() {
  const candidates = globalConfigCandidates();
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return candidates[0];
}

/**
 * Strip `//` and block comments plus trailing commas so `.jsonc` files parse.
 *
 * Deliberately conservative: it tracks string state so `//` inside a URL is
 * never mistaken for a comment, which matters because base URLs live here.
 */
export function parseJsonc(text) {
  let out = "";
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (inString) {
      out += char;
      if (char === "\\") {
        out += next ?? "";
        i += 1;
      } else if (char === quote) {
        inString = false;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      inString = true;
      quote = char;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
      out += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    out += char;
  }
  // Drop trailing commas before a closing brace or bracket.
  return out.replace(/,(\s*[}\]])/gu, "$1");
}

/** Read the config document, returning `{}` for a missing file. */
export function readConfig(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(parseJsonc(text));
  } catch (error) {
    throw new Error(`existing config at ${path} is not valid JSON/JSONC: ${error.message}`);
  }
}

/**
 * Write the config atomically, preserving unknown fields.
 *
 * The document is validated first: writing a schema-invalid file would make
 * MiMo Desktop refuse the whole configuration, which is far worse than a failed
 * install, so this throws before touching the existing file.
 */
export function writeConfig(path, document, { skipValidation = false } = {}) {
  if (!skipValidation) {
    const problems = validateConfigDocument(document);
    if (problems.length > 0) {
      throw new Error(
        `refusing to write a configuration MiMoCode would reject:\n  - ${problems.join("\n  - ")}`,
      );
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}

/**
 * Build the `provider.<id>` block for one variant.
 *
 * Every key emitted here must exist in MiMoCode's `ProviderConfig` schema,
 * which sets `additionalProperties: false` — an unknown key does not get
 * ignored, it invalidates the whole file.
 *
 * @param {object} options
 * @param {number} options.port - local relay port.
 * @param {string} options.providerId - {@link PROVIDER_ID} or {@link PROVIDER_ID_AI}.
 * @param {string} options.displayName
 * @param {object} options.models - map of model id to MiMoCode options.
 */
export function buildProviderBlock({ port, providerId, displayName, models }) {
  return {
    name: displayName,
    npm: "@ai-sdk/openai-compatible",
    // Only the models we enumerate should appear, not everything the endpoint lists.
    only_configured_models: true,
    models,
    options: {
      baseURL: `http://127.0.0.1:${port}/v1`,
      // The relay authenticates against the WorkBuddy app's own sign-in, so the
      // key is a placeholder MiMoCode requires to be non-empty. Its exact value
      // also identifies blocks we own, since the schema permits no marker key.
      apiKey: RELAY_API_KEY,
    },
  };
}

/**
 * Merge provider blocks into the config document, and optionally set the
 * default model. Existing unrelated configuration is preserved.
 *
 * The ownership marker is stored *inside* each provider block, never at the
 * root: MiMoCode's schema rejects unknown top-level keys outright.
 */
export function applyProviders(document, providers, defaultModel) {
  const next = { ...document };
  next["$schema"] = next["$schema"] ?? "https://mimo.xiaomi.com/mimocode/config.json";
  next["provider"] = { ...(next["provider"] ?? {}) };
  for (const [id, block] of Object.entries(providers)) {
    next["provider"][id] = block;
  }
  if (defaultModel !== undefined) next["model"] = defaultModel;
  // A previous release wrote the marker at the root, which invalidated the file.
  delete next[MANAGED_KEY];
  return next;
}

/**
 * Provider ids we own.
 *
 * There is nowhere legal to keep an ownership marker: MiMoCode's schema sets
 * `additionalProperties: false` at both the root and `ProviderConfig`, so any
 * marker key makes the file invalid. Ownership is therefore recognised
 * structurally — our fixed ids, and the sentinel api key we write.
 */
function ownedProviderIds(document) {
  const providers = document?.["provider"];
  if (providers === undefined || typeof providers !== "object" || providers === null) return [];
  const ids = [];
  for (const id of [PROVIDER_ID, PROVIDER_ID_AI]) {
    const block = providers[id];
    if (block === undefined) continue;
    // A block under our id carrying our sentinel key is ours; anything else was
    // written by the user in the UI and is left alone.
    if (block?.options?.apiKey === RELAY_API_KEY) ids.push(id);
  }
  // Honour a marker written by an earlier release, so upgrades clean up fully.
  const legacy = document?.[MANAGED_KEY]?.providerIds;
  if (Array.isArray(legacy)) {
    for (const id of legacy) {
      if (providers[id] !== undefined && !ids.includes(id)) ids.push(id);
    }
  }
  return ids;
}

/** Remove our provider blocks, leaving everything else intact. */
export function removeProviders(document) {
  const next = { ...document };
  const ids = ownedProviderIds(document);
  if (next["provider"] !== undefined) {
    next["provider"] = { ...next["provider"] };
    for (const id of ids) delete next["provider"][id];
    if (Object.keys(next["provider"]).length === 0) delete next["provider"];
  }
  // Clear the default model only when it pointed at a provider we own.
  if (typeof next["model"] === "string" && ids.some((id) => next["model"].startsWith(`${id}/`))) {
    delete next["model"];
  }
  // Remove the root marker an earlier release wrote, which invalidated the file.
  delete next[MANAGED_KEY];
  return next;
}

/** Whether this document currently carries our configuration. */
export function isManaged(document) {
  return ownedProviderIds(document).length > 0;
}

export const internals = { MANAGED_KEY, MANAGED_VERSION, RELAY_API_KEY };
