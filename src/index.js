/**
 * mimo-workbuddy-connect — bring WorkBuddy desktop models into Xiaomi MiMo
 * Desktop (MiMoCode).
 *
 * Functionally the counterpart of `dsh-workbuddy-connect`: it reuses the
 * WorkBuddy app's own sign-in, enumerates the account's model catalog, and
 * makes those models selectable — but the host it plugs into is MiMo Desktop
 * rather than DeepSeek Harness.
 *
 * @module mimo-workbuddy-connect
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { VARIANTS, statePath } from "./auth.js";
import { toProviderModels } from "./catalog.js";
import { buildProviderBlock, portForProvider, PROVIDER_ID, PROVIDER_ID_AI } from "./provider.js";

export { VARIANTS, readWorkBuddyCredential } from "./auth.js";
export { parseModelCatalog, toProviderModels } from "./catalog.js";
export { CredentialSession } from "./session.js";
export { RelayServer } from "./server.js";
export { WorkBuddyUpstreamClient } from "./upstream.js";
export * from "./provider.js";

const DEFAULT_LOG = (message) => {
  process.stdout.write(`[mimo-workbuddy-connect] ${message}\n`);
};

/**
 * One variant's runtime: credential session, catalog cache, and relay server.
 */
export class VariantRuntime {
  /**
   * @param {object} options
   * @param {object} options.variant
   * @param {number} [options.port] - preferred relay port; defaults to the
   *   variant's stable port, falling back to a free one only if it is taken.
   * @param {(message: string) => void} [options.log]
   */
  constructor({ variant, port, log = DEFAULT_LOG }) {
    this.variant = variant;
    this.preferredPort = port ?? portForProvider(variant.id === "ai" ? PROVIDER_ID_AI : PROVIDER_ID);
    this.log = log;
    this.models = [];
    this.catalogSource = "none";
    this.catalogFetchedAtMs = 0;
    this.catalogError = undefined;
  }

  /**
   * Build the session and catalog without binding a listening socket.
   *
   * Read-only commands (`status`, `doctor`) use this so they work while the
   * installed relay is already running and holding the port.
   */
  async prepare() {
    const { CredentialSession } = await import("./session.js");
    const { WorkBuddyUpstreamClient } = await import("./upstream.js");

    this.upstream = new WorkBuddyUpstreamClient();
    this.session = new CredentialSession({ variant: this.variant, upstream: this.upstream, log: this.log });
    await this.session.ensureCredential();
    await this.loadCatalog();
    return this;
  }

  /** Build the session, client and server, then start listening. */
  async start() {
    const { CredentialSession } = await import("./session.js");
    const { RelayServer } = await import("./server.js");
    const { WorkBuddyUpstreamClient } = await import("./upstream.js");

    this.upstream = new WorkBuddyUpstreamClient();
    this.session = new CredentialSession({ variant: this.variant, upstream: this.upstream, log: this.log });
    await this.session.ensureCredential();
    this.session.start();

    await this.loadCatalog();

    this.server = new RelayServer({
      session: this.session,
      upstream: this.upstream,
      getModels: () => this.models,
      log: this.log,
    });
    // Refuse a silent port change: MiMoCode's config records this exact URL, so
    // a fallback port would be written into configuration and then go stale.
    this.port = await this.server.listen(this.preferredPort, { fallbackToEphemeral: false });
    return this;
  }

  /** Fetch the model catalog, falling back to the last saved one. */
  async loadCatalog() {
    if (!(await this.session.ensureCredential())) {
      this.catalogError = this.session.lastError ?? "not signed in";
      this.loadSavedCatalog();
      return this.models;
    }
    try {
      this.models = await this.upstream.fetchModels(this.session.credential);
      this.catalogSource = "live";
      this.catalogFetchedAtMs = Date.now();
      this.catalogError = undefined;
      this.saveCatalog();
    } catch (error) {
      this.catalogError = error.message;
      this.log(`${this.variant.displayName}: catalog unavailable (${error.message}); using saved copy`);
      this.loadSavedCatalog();
    }
    return this.models;
  }

  /**
   * Discover reasoning-effort levels for models that do not declare them.
   *
   * Opt-in: each level costs one upstream request per model, so this runs only
   * when asked (by `install --probe-efforts` or `doctor --probe-efforts`).
   * Results are cached per account, so repeat runs are free.
   *
   * @param {object} [options]
   * @param {boolean} [options.force] - ignore the cache and probe again.
   */
  async probeEfforts({ force = false } = {}) {
    const { ProbeStore, resolveEfforts } = await import("./probe-store.js");
    const { EFFORT_VALUES } = await import("./catalog.js");

    if (!(await this.session.ensureCredential())) return 0;
    if (this.probeStore === undefined) this.probeStore = new ProbeStore(this.variant.probeFilename);
    const account = this.session.credential.uid || "unknown";

    const targets = this.models.filter(
      (model) => model.reasoning?.supports === true && !model.reasoning.supportedEfforts?.length,
    );
    if (targets.length === 0) return 0;

    this.log(`${this.variant.displayName}: probing effort levels for ${targets.length} model(s)`);
    let probed = 0;
    for (const model of targets) {
      const cached = force ? undefined : this.probeStore.get(account, model);
      if (cached !== undefined) {
        // Replay both halves of the cached verdict, so an uncallable model stays
        // excluded and a probed one keeps its levels.
        if (cached.efforts.length > 0) {
          model.reasoning.supportedEfforts = cached.efforts;
          if (model.reasoning.defaultEffort === undefined) model.reasoning.defaultEffort = "high";
        } else if (cached.unavailable) {
          model.unavailable = true;
        }
        continue;
      }
      const { efforts, unavailable } = await resolveEfforts({
        upstream: this.upstream,
        credential: this.session.credential,
        model,
        candidates: EFFORT_VALUES,
        account,
        store: this.probeStore,
        log: this.log,
      });
      probed += 1;
      if (efforts.length > 0) {
        model.reasoning.supportedEfforts = efforts;
        if (model.reasoning.defaultEffort === undefined) model.reasoning.defaultEffort = "high";
      } else if (unavailable) {
        model.unavailable = true;
      } else {
        this.log(`${model.id}: no effort level was accepted; keeping the upstream default`);
      }
    }
    this.probeStore.save();
    this.saveCatalog();
    return probed;
  }

  /** Persist the catalog so a later offline start still lists models. */
  saveCatalog() {
    try {
      const path = statePath(this.variant.catalogFilename);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        `${JSON.stringify({ version: 1, fetchedAtMs: this.catalogFetchedAtMs, models: this.models }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      this.log(`could not save catalog: ${error.message}`);
    }
  }

  /** Restore the last saved catalog. */
  loadSavedCatalog() {
    const path = statePath(this.variant.catalogFilename);
    if (!existsSync(path)) return;
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (Array.isArray(parsed?.models)) {
        this.models = parsed.models;
        this.catalogSource = "saved";
        this.catalogFetchedAtMs = parsed.fetchedAtMs ?? 0;
      }
    } catch {
      /* ignore a corrupt catalog */
    }
  }

  /** MiMoCode provider id for this variant. */
  get providerId() {
    return this.variant.id === "ai" ? PROVIDER_ID_AI : PROVIDER_ID;
  }

  /** The `provider.<id>` block for this variant's live catalog. */
  providerBlock() {
    return buildProviderBlock({
      port: this.port,
      providerId: this.providerId,
      displayName: this.variant.displayName,
      models: toProviderModels(this.models),
    });
  }

  /** Start the credential refresh loop, for a runtime that will keep serving. */
  startRefreshLoop() {
    this.session?.start();
  }

  /** Status for `/health` and the CLI. */
  describe() {
    return {
      ...this.session.describe(),
      port: this.port,
      models: this.models.length,
      catalogSource: this.catalogSource,
      catalogFetchedAtMs: this.catalogFetchedAtMs || undefined,
      catalogError: this.catalogError,
    };
  }

  async stop() {
    this.session?.stop();
    await this.server?.close();
  }
}

/**
 * Start every requested variant.
 *
 * @param {object} [options]
 * @param {string[]} [options.variants] - variant ids to start; defaults to all
 *   that have a readable sign-in.
 * @param {number} [options.port] - preferred port for the first variant.
 * @param {(message: string) => void} [options.log]
 */
export async function startAll({ variants, port, log = DEFAULT_LOG } = {}) {
  const ids = variants ?? Object.keys(VARIANTS);
  const runtimes = [];
  for (const id of ids) {
    const variant = VARIANTS[id];
    if (variant === undefined) throw new Error(`unknown variant: ${id}`);
    const runtime = new VariantRuntime({ variant, port, log });
    try {
      await runtime.start();
    } catch (error) {
      if (error.code === "EADDRINUSE") {
        throw new Error(
          `the relay port for ${variant.displayName} is already in use, so the existing ` +
            `configuration still points at a running instance; stop it first, or set ` +
            `MIMO_WORKBUDDY_PORT to a free port and re-run install`,
        );
      }
      throw error;
    }
    runtimes.push(runtime);
  }
  return runtimes;
}
