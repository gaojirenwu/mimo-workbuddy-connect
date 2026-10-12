/**
 * Model catalog parsing: upstream `/v3/config` rows into the shape MiMoCode's
 * model selector and context accounting need.
 *
 * Ported from `dsh-workbuddy-connect`'s `model-catalog.ts`. The upstream
 * document carries more rows than are usable (agents, internal entries), so
 * membership is the chat roster intersected with the rows that declare a model.
 *
 * @module mimo-workbuddy-connect/catalog
 */

/** The concrete effort spellings WorkBuddy exposes on the wire. */
export const EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"];

/** Promotional badge keys the upstream tags carry, minus their color suffix. */
const BADGE_PREFIX = "badge:";

/**
 * Reduce an upstream credits string to its language-neutral display form.
 *
 * The upstream is inconsistent: some rows report a bare multiplier (`x0.79`)
 * and others append a unit word (`x0.79 credits`). Dropping the trailing unit
 * yields the one spelling that reads identically in every language.
 */
export function normalizeCredits(credits) {
  if (credits === undefined) return undefined;
  const trimmed = String(credits).trim();
  if (trimmed === "") return undefined;
  if (/^credits?$/iu.test(trimmed)) return undefined;
  const bare = trimmed.replace(/\s+credits?$/iu, "").trim();
  return bare === "" ? undefined : bare;
}

/** Parse the upstream `reasoning` object into a normalized descriptor. */
function resolveUpstreamReasoning(wrapped) {
  const supports = wrapped["supportsReasoning"] === true;
  const onlyReasoning = wrapped["onlyReasoning"] === true;
  const rawReasoning = wrapped["reasoning"];
  let supportedEfforts;
  let defaultEffort;
  let canDisableThinking = true;
  if (typeof rawReasoning === "object" && rawReasoning !== null && !Array.isArray(rawReasoning)) {
    const rawEfforts = rawReasoning["supportedEfforts"];
    if (Array.isArray(rawEfforts)) {
      const efforts = rawEfforts.filter(
        (value) => typeof value === "string" && EFFORT_VALUES.includes(value),
      );
      if (efforts.length > 0) supportedEfforts = efforts;
    }
    if (typeof rawReasoning["defaultEffort"] === "string" && EFFORT_VALUES.includes(rawReasoning["defaultEffort"])) {
      defaultEffort = rawReasoning["defaultEffort"];
    } else if (typeof rawReasoning["effort"] === "string" && EFFORT_VALUES.includes(rawReasoning["effort"])) {
      defaultEffort = rawReasoning["effort"];
    }
    canDisableThinking = rawReasoning["canDisableThinking"] === true;
  }
  return {
    supports,
    onlyReasoning,
    ...(supportedEfforts === undefined ? {} : { supportedEfforts }),
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
    canDisableThinking,
  };
}

/** Parse the upstream `tags` / `credits` fields into billing metadata. */
function resolveUpstreamBilling(wrapped, extraTags) {
  const rawCredits = wrapped["credits"];
  const credits = typeof rawCredits === "string" && rawCredits.trim() !== "" ? rawCredits.trim() : undefined;
  const badges = [];
  const rawTags = [...(Array.isArray(wrapped["tags"]) ? wrapped["tags"] : []), ...(extraTags ?? [])];
  for (const tag of rawTags) {
    if (typeof tag !== "string") continue;
    if (!tag.toLowerCase().startsWith(BADGE_PREFIX)) continue;
    const label = tag.slice(BADGE_PREFIX.length).split(":")[0] || tag.slice(BADGE_PREFIX.length);
    if (label !== "" && !badges.includes(label)) badges.push(label);
  }
  const multiplier = normalizeCredits(credits);
  const free = multiplier !== undefined && /^x?0\.0+$/u.test(multiplier);
  return {
    ...(credits === undefined ? {} : { credits }),
    ...(badges.length === 0 ? {} : { badges }),
    free,
  };
}

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Numeric field with a sane default. */
function positiveInt(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** Pick the display name from the upstream row's several name-bearing fields. */
function displayNameOf(row, id) {
  for (const key of ["name", "displayName", "title", "label"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return id;
}

/**
 * Parse the upstream catalog document into model entries.
 *
 * The document is searched for the chat roster in a small set of known
 * containers, because the product document has changed shape across releases.
 *
 * @param {object} document - upstream `/v3/config` data (or the whole envelope).
 * @param {boolean} international - whether this is the WorkBuddy AI variant.
 * @returns {Array<object>} model entries.
 */
export function parseModelCatalog(document, international = false) {
  if (!isObject(document)) return [];
  const containers = ["models", "chatModels", "cliModels", "agents"];
  let rows;
  for (const key of containers) {
    const value = document[key];
    if (Array.isArray(value) && value.length > 0) {
      rows = value;
      break;
    }
    if (isObject(value)) {
      const entries = Object.entries(value);
      if (entries.length > 0) {
        rows = entries.map(([id, row]) =>
          isObject(row) ? { id, ...row } : { id, name: String(row) },
        );
        break;
      }
    }
  }
  if (rows === undefined && Array.isArray(document["data"])) rows = document["data"];
  if (rows === undefined) return [];

  const models = [];
  const seen = new Set();
  for (const raw of rows) {
    if (!isObject(raw)) continue;
    const id =
      typeof raw["id"] === "string" && raw["id"].trim() !== ""
        ? raw["id"].trim()
        : typeof raw["model"] === "string" && raw["model"].trim() !== ""
          ? raw["model"].trim()
          : typeof raw["name"] === "string" && raw["name"].trim() !== ""
            ? raw["name"].trim()
            : undefined;
    if (id === undefined || seen.has(id)) continue;
    // Skip rows the chat endpoint cannot serve.
    if (raw["enabled"] === false || raw["disabled"] === true || raw["available"] === false) continue;
    seen.add(id);

    const reasoning = resolveUpstreamReasoning(raw);
    const billing = resolveUpstreamBilling(raw);
    const contextWindow =
      positiveInt(raw["contextWindow"]) ??
      positiveInt(raw["context_length"]) ??
      positiveInt(raw["maxInputTokens"]) ??
      positiveInt(raw["maxContextTokens"]);
    const maxTokens =
      positiveInt(raw["maxTokens"]) ??
      positiveInt(raw["maxOutputTokens"]) ??
      positiveInt(raw["max_tokens"]);

    models.push({
      id,
      name: displayNameOf(raw, id),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
      supportsImages:
        raw["supportsImages"] === true ||
        raw["supportsVision"] === true ||
        raw["multimodal"] === true ||
        raw["vision"] === true,
      reasoning,
      billing,
      variant: international ? "ai" : "cn",
    });
  }
  return models;
}

/**
 * Build MiMoCode variant entries that expose reasoning effort as a choice.
 *
 * MiMoCode merges `model.variants` from configuration over its own built-ins
 * (config wins, and `disabled: true` removes an entry), and the variant keys
 * become the selectable levels in the UI. That is the supported way to offer
 * "low / high / max" rather than hard-coding one effort.
 *
 * Only efforts the upstream actually declared are emitted: WorkBuddy accepts
 * `reasoning_effort` but silently ignores unknown values and falls back to its
 * default, so inventing levels would present choices that do nothing.
 *
 * @param {object} model - catalog entry.
 * @returns {object|undefined} variants map, or undefined when none apply.
 */
export function toProviderVariants(model) {
  const reasoning = model.reasoning;
  if (reasoning?.supports !== true) return undefined;
  const efforts = reasoning.supportedEfforts;
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined;

  const variants = {};
  for (const effort of efforts) {
    variants[effort] = { reasoningEffort: effort };
  }
  return variants;
}

/**
 * Build the label MiMoCode shows in its model picker.
 *
 * This is the model's own name and nothing else.
 *
 * The credit multiplier and promo badges deliberately do NOT go here. A
 * configured model name is a static string: MiMoCode reads it once at startup
 * and never re-asks upstream, so a rate baked into the name goes stale the
 * moment WorkBuddy changes its pricing — and a confidently wrong rate is worse
 * than no rate. The same values are available live from `status --rates`, which
 * queries upstream on demand.
 */
export function modelLabel(model) {
  return model.name;
}

/** Rate and badge text for the live `status --rates` view. */
export function billingLabel(model) {
  const parts = [];
  // Reuse the language-neutral form: the upstream sometimes appends an English
  // unit word, which would read wrong in a Chinese UI.
  const credits = normalizeCredits(model.billing?.credits);
  if (credits !== undefined) parts.push(credits);
  for (const badge of model.billing?.badges ?? []) {
    if (typeof badge === "string" && badge.trim() !== "") parts.push(badge.trim());
  }
  return parts.join("  ");
}

/**
 * Reduce catalog entries to the options MiMoCode's provider config needs.
 *
 * Field placement matters: MiMoCode validates model entries with
 * `additionalProperties: false`, and `limit` requires *both* `context` and
 * `output`. An `output` left at the model's top level makes the whole config
 * invalid, so it is only ever emitted inside `limit`, and only when both numbers
 * are known — otherwise `limit` is omitted entirely.
 */
export function toProviderModels(models) {
  const out = {};
  for (const model of models) {
    // A model the account cannot call would only produce errors if offered.
    if (model.unavailable === true) continue;
    const entry = { name: modelLabel(model) };
    if (model.contextWindow !== undefined && model.maxTokens !== undefined) {
      entry.limit = { context: model.contextWindow, output: model.maxTokens };
    }
    if (model.supportsImages) entry.attachment = true;
    if (model.reasoning?.supports) {
      entry.reasoning = true;
      // The baseline effort a request uses when the user picks no variant.
      entry.options = { reasoningEffort: model.reasoning.defaultEffort ?? "high" };
      const variants = toProviderVariants(model);
      if (variants !== undefined) entry.variants = variants;
    }
    out[model.id] = entry;
  }
  return out;
}

/** Fingerprint a catalog so visibility/probe state can be invalidated safely. */
export function fingerprintModel(model) {
  return [model.id, model.contextWindow ?? "", model.maxTokens ?? "", model.supportsImages ? "i" : ""].join("|");
}
