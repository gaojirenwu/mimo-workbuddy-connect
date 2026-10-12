/**
 * Cached reasoning-effort probe results.
 *
 * Probing costs a request per effort per model, so results are cached per
 * account and reused until the model's fingerprint or the plugin version
 * changes. This mirrors `dsh-workbuddy-connect`'s probe store, which caches for
 * the same reason.
 *
 * @module mimo-workbuddy-connect/probe-store
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { statePath } from "./auth.js";
import { fingerprintModel } from "./catalog.js";

/** Re-probe after this long even when nothing visibly changed. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Persistent map of `account -> modelId -> accepted efforts`.
 */
export class ProbeStore {
  constructor(filename) {
    this.path = statePath(filename);
    this.records = {};
    this.load();
  }

  load() {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed.records === "object" && parsed.records !== null) {
        this.records = parsed.records;
      }
    } catch {
      this.records = {};
    }
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(
        this.path,
        `${JSON.stringify({ version: 2, records: this.records }, null, 2)}\n`,
        "utf8",
      );
    } catch {
      /* a cache that cannot be written is not fatal */
    }
  }

  /**
   * Cached probe result for one model, or undefined when absent or stale.
   *
   * The stored record keeps the unavailable flag alongside the efforts: an empty
   * effort list alone cannot distinguish "the account cannot call this model"
   * from "no level was accepted", and losing that would let an uncallable model
   * back into the picker on the next cached run.
   */
  get(account, model) {
    const record = this.records?.[account]?.[model.id];
    if (record === undefined) return undefined;
    if (record.fingerprint !== fingerprintModel(model)) return undefined;
    if (typeof record.probedAtMs === "number" && Date.now() - record.probedAtMs > MAX_AGE_MS) {
      return undefined;
    }
    if (!Array.isArray(record.efforts)) return undefined;
    return { efforts: record.efforts, unavailable: record.unavailable === true };
  }

  /** Record the accepted efforts for one model. */
  set(account, model, efforts, unavailable = false) {
    const accountRecord = { ...(this.records[account] ?? {}) };
    accountRecord[model.id] = {
      fingerprint: fingerprintModel(model),
      efforts,
      unavailable: unavailable === true,
      probedAtMs: Date.now(),
    };
    this.records = { ...this.records, [account]: accountRecord };
  }
}

/**
 * Discover which efforts a model accepts, using the cache when it is warm.
 *
 * The declared list wins when the upstream provides one — it is authoritative
 * and costs nothing. Otherwise each level is probed, and a level that stays
 * ambiguous is excluded rather than offered, because showing a choice the
 * upstream would reject is worse than showing fewer choices.
 *
 * @returns {Promise<{efforts: string[], unavailable: boolean}>} accepted levels
 *   in canonical order, and whether the model cannot be called at all.
 */
export async function resolveEfforts({
  upstream,
  credential,
  model,
  candidates,
  account,
  store,
  log = () => {},
}) {
  const declared = model.reasoning?.supportedEfforts;
  if (Array.isArray(declared) && declared.length > 0) {
    return { efforts: declared, unavailable: false };
  }

  const cached = store?.get(account, model);
  if (cached !== undefined) return cached;

  const accepted = [];
  let sawUnavailable = false;
  for (const effort of candidates) {
    const verdict = await upstream.probeEffort(credential, model.id, effort);
    if (verdict === "accepted") accepted.push(effort);
    else if (verdict === "unavailable") {
      // Every level reports the same thing; one is enough to conclude.
      sawUnavailable = true;
      break;
    } else if (verdict === "inconclusive") {
      log(`${model.id}: could not confirm "${effort}"; leaving it out`);
    }
  }

  if (sawUnavailable) {
    log(`${model.id}: the account cannot call this model (listed but unavailable)`);
  }

  store?.set(account, model, accepted, sawUnavailable);
  return { efforts: accepted, unavailable: sawUnavailable };
}

export const internals = { MAX_AGE_MS };
