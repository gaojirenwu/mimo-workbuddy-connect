/**
 * Credential lifecycle: read the WorkBuddy app's sign-in, refresh the access
 * token on a schedule and on 401/403, and hand callers a usable credential.
 *
 * Mirrors `dsh-workbuddy-connect`'s credential store: the app's own file is the
 * source of truth, re-read when the upstream rejects the session, so signing in
 * (or switching accounts) in WorkBuddy is picked up without restarting MiMo.
 *
 * @module mimo-workbuddy-connect/session
 */
import { writeFileSync, mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { readWorkBuddyCredentialAsync, statePath } from "./auth.js";

const REFRESH_INTERVAL_MS = 30 * 60 * 1000;
/** Refresh early rather than exactly at expiry. */
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

/**
 * Owns one variant's credential and the refresh loop.
 */
export class CredentialSession {
  /**
   * @param {object} options
   * @param {object} options.variant - one of {@link VARIANTS}.
   * @param {import('./upstream.js').WorkBuddyUpstreamClient} options.upstream
   * @param {(message: string) => void} [options.log]
   */
  constructor({ variant, upstream, log = () => {} }) {
    this.variant = variant;
    this.upstream = upstream;
    this.log = log;
    /** @type {object|undefined} */
    this.credential = undefined;
    this.source = "none";
    this.authPath = undefined;
    this.lastError = undefined;
    this.lastRefreshAtMs = 0;
    this.timer = undefined;
    this.refreshing = undefined;
  }

  /** Read the app's auth file, replacing the in-memory credential on success. */
  async loadFromApp() {
    const result = await readWorkBuddyCredentialAsync(this.variant);
    if (result.error !== undefined) {
      this.lastError = result.error;
      this.log(`${this.variant.displayName}: ${result.error}`);
      return false;
    }
    this.credential = result.credential;
    this.authPath = result.path;
    this.source = result.decrypted === true ? "app-encrypted" : "app";
    this.lastError = undefined;
    return true;
  }

  /** The plugin's own cached copy, used only when the app's file is unreadable. */
  loadCached() {
    const path = statePath(this.variant.ownFilename);
    if (!existsSync(path)) return false;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (parsed && typeof parsed.accessToken === "string" && parsed.accessToken !== "") {
        this.credential = {
          accessToken: parsed.accessToken,
          refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : "",
          expiresAtMs: typeof parsed.expiresAtMs === "number" ? parsed.expiresAtMs : 0,
          domain: typeof parsed.domain === "string" ? parsed.domain : "",
          uid: typeof parsed.uid === "string" ? parsed.uid : "",
          enterpriseId: typeof parsed.enterpriseId === "string" ? parsed.enterpriseId : undefined,
          encrypted: false,
        };
        this.source = "cache";
        return true;
      }
    } catch {
      /* ignore a corrupt cache */
    }
    return false;
  }

  /** Persist the current credential for offline reuse (never logged). */
  saveCached() {
    if (this.credential === undefined) return;
    try {
      const path = statePath(this.variant.ownFilename);
      mkdirSync(dirname(path), { recursive: true });
      const { accessToken, refreshToken, expiresAtMs, domain, uid, enterpriseId } = this.credential;
      writeFileSync(
        path,
        `${JSON.stringify({ accessToken, refreshToken, expiresAtMs, domain, uid, enterpriseId }, null, 2)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      this.log(`could not write credential cache: ${error.message}`);
    }
  }

  /** Ensure a credential exists: app file first, plugin cache as fallback. */
  async ensureCredential() {
    if (this.credential !== undefined && this.credential.accessToken !== "") return true;
    if (await this.loadFromApp()) {
      this.saveCached();
      return true;
    }
    if (this.loadCached()) {
      this.log(`${this.variant.displayName}: using the plugin's cached credential`);
      return true;
    }
    return false;
  }

  /**
   * Refresh the access token, single-flight. On an upstream rejection the app's
   * auth file is re-read once, which is what makes a re-login in WorkBuddy
   * self-heal without restarting MiMo.
   */
  async refresh({ allowReread = true } = {}) {
    if (this.refreshing !== undefined) return this.refreshing;
    this.refreshing = (async () => {
      if (!(await this.ensureCredential())) return false;
      try {
        const outcome = await this.upstream.refreshToken(this.credential);
        this.credential = {
          ...this.credential,
          accessToken: outcome.accessToken,
          ...(outcome.refreshToken === undefined ? {} : { refreshToken: outcome.refreshToken }),
          ...(outcome.domain === undefined ? {} : { domain: outcome.domain }),
          expiresAtMs:
            outcome.expiresInSec === undefined ? 0 : Date.now() + outcome.expiresInSec * 1000,
        };
        this.lastRefreshAtMs = Date.now();
        this.lastError = undefined;
        this.saveCached();
        this.log(`${this.variant.displayName}: session refreshed`);
        return true;
      } catch (error) {
        this.lastError = error.message;
        this.log(`${this.variant.displayName}: refresh failed (${error.message})`);
        if (allowReread && (await this.loadFromApp())) {
          this.log(`${this.variant.displayName}: re-read credentials from the app, retrying`);
          return this.refresh({ allowReread: false });
        }
        return false;
      }
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  /** True when the token is missing, expired, or close to expiring. */
  needsRefresh() {
    if (this.credential === undefined || this.credential.accessToken === "") return true;
    if (this.credential.expiresAtMs === 0) return false;
    return Date.now() + EXPIRY_SKEW_MS >= this.credential.expiresAtMs;
  }

  /** Start the periodic refresh loop. */
  start() {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, REFRESH_INTERVAL_MS);
    // Never hold the process open just for the refresh timer.
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop() {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Human-readable state for `/health` and the status command. */
  describe() {
    const credential = this.credential;
    return {
      variant: this.variant.id,
      displayName: this.variant.displayName,
      signedIn: credential !== undefined && credential.accessToken !== "",
      source: this.source,
      authPath: this.authPath,
      account: credential?.uid ?? undefined,
      enterprise: credential?.enterpriseId ?? undefined,
      domain: credential?.domain ?? undefined,
      expiresAtMs: credential?.expiresAtMs || undefined,
      lastRefreshAtMs: this.lastRefreshAtMs || undefined,
      error: this.lastError,
    };
  }
}
