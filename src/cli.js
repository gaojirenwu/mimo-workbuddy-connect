#!/usr/bin/env node
/**
 * Command line for mimo-workbuddy-connect.
 *
 *   node src/cli.js install    write the MiMoCode provider config
 *   node src/cli.js uninstall  remove it
 *   node src/cli.js status     credential + catalog + relay state
 *   node src/cli.js serve      run the relay in the foreground
 *
 * @module mimo-workbuddy-connect/cli
 */
import { existsSync } from "node:fs";
import { startAll, VARIANTS } from "./index.js";
import { billingLabel } from "./catalog.js";
import {
  applyProviders,
  buildProviderBlock,
  DEFAULT_PORTS,
  isManaged,
  PROVIDER_ID,
  PROVIDER_ID_AI,
  readConfig,
  removeProviders,
  resolveConfigPath,
  validateConfigDocument,
  writeConfig,
} from "./provider.js";

const args = process.argv.slice(2);
const command = args[0] ?? "status";
const flags = new Set(args.slice(1).filter((a) => a.startsWith("--")));
const json = flags.has("--json");

const variantFlag = args.find((a) => a.startsWith("--provider="));
const selectedVariants =
  variantFlag === undefined
    ? ["cn"]
    : variantFlag
        .slice("--provider=".length)
        .split(",")
        .map((id) => (id === "workbuddy-ai" ? "ai" : id));

const log = json ? () => {} : (message) => process.stdout.write(`[mimo-workbuddy-connect] ${message}\n`);

/** Build runtimes on their stable ports so generated config stays valid. */
async function probe() {
  const runtimes = await startAll({ variants: selectedVariants, log });
  return runtimes;
}

/**
 * Build runtimes for read-only commands.
 *
 * The installed relay may already be running and holding the port, so these
 * commands prepare sessions without binding — otherwise `status` and `doctor`
 * would fail exactly when the install is working correctly.
 */
async function prepareRuntimes() {
  const { VariantRuntime } = await import("./index.js");
  const runtimes = [];
  for (const id of selectedVariants) {
    const variant = VARIANTS[id];
    if (variant === undefined) throw new Error(`unknown variant: ${id}`);
    runtimes.push(await new VariantRuntime({ variant, log }).prepare());
  }
  return runtimes;
}

/** Whether a relay is already answering on the variant's port. */
async function relayAlreadyRunning(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Build a provider block for an already-running relay.
 *
 * The running relay is the authority for its own model list, so the catalog is
 * read back over HTTP and the URL points at the port that is actually serving.
 */
async function buildProviderBlockFor({ providerId, displayName, port }) {
  return buildProviderBlock({
    port,
    providerId,
    displayName,
    models: await modelsFromRunningRelay(port),
  });
}

/** Fetch the catalog a running relay is serving, as MiMoCode model options. */
async function modelsFromRunningRelay(port) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    signal: AbortSignal.timeout(5000),
  });
  const payload = await response.json();
  const out = {};
  for (const model of payload.data ?? []) {
    out[model.id] = { name: model.id };
  }
  return out;
}

async function withRuntimes(fn) {
  const runtimes = await probe();
  try {
    return await fn(runtimes);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
  }
}

/** Run read-only work without binding a socket. */
async function withPreparedRuntimes(fn) {
  const runtimes = await prepareRuntimes();
  try {
    return await fn(runtimes);
  } finally {
    for (const runtime of runtimes) runtime.session?.stop();
  }
}

/**
 * Run work that needs a provider block and a live relay port.
 *
 * When a relay is already serving, it is reused instead of failing to bind —
 * otherwise `install` would break exactly when the install is working. The
 * reused handle exposes the same surface the install path consumes, so both
 * branches produce identical configuration.
 */
async function withBoundRuntimes(fn) {
  const ports = selectedVariants.map((id) => (id === "ai" ? DEFAULT_PORTS.ai : DEFAULT_PORTS.cn));
  const running = await Promise.all(ports.map(relayAlreadyRunning));
  if (running.every(Boolean)) {
    log("a relay is already running; refreshing configuration against it");
    const handles = selectedVariants.map((id, index) => {
      const providerId = id === "ai" ? PROVIDER_ID_AI : PROVIDER_ID;
      const port = ports[index];
      return {
        variant: VARIANTS[id],
        providerId,
        port,
        models: [],
        async providerBlock() {
          return buildProviderBlockFor({ providerId, displayName: VARIANTS[id].displayName, port });
        },
      };
    });
    return fn(handles, true);
  }
  const runtimes = await probe();
  try {
    return await fn(runtimes, false);
  } finally {
    for (const runtime of runtimes) await runtime.stop();
  }
}

const commands = {
  async status() {
    await withPreparedRuntimes(async (runtimes) => {
      const report = runtimes.map((runtime) => runtime.describe());
      if (json) return process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      for (const status of report) {
        process.stdout.write(`\n${status.displayName}\n`);
        process.stdout.write(`  signed in   : ${status.signedIn ? "yes" : "no"}\n`);
        process.stdout.write(`  credential  : ${status.source}\n`);
        if (status.authPath) process.stdout.write(`  auth file   : ${status.authPath}\n`);
        if (status.account) process.stdout.write(`  account     : ${status.account}\n`);
        if (status.domain) process.stdout.write(`  domain      : ${status.domain}\n`);
        process.stdout.write(`  models      : ${status.models} (${status.catalogSource})\n`);
        if (status.error) process.stdout.write(`  error       : ${status.error}\n`);
      }
      // Rates and badges are read live from the upstream catalog here, on
      // demand. They are deliberately not written into the model names in the
      // config, where they would go stale as soon as pricing changed.
      if (flags.has("--rates")) {
        for (const runtime of runtimes) {
          if (runtime.models.length === 0) continue;
          process.stdout.write(`\n${runtime.variant.displayName} rates (live from upstream)\n`);
          for (const model of runtime.models) {
            const bits = billingLabel(model);
            const mark = model.unavailable === true ? "  (unavailable)" : "";
            process.stdout.write(`  ${model.id.padEnd(24)} ${bits}${mark}\n`);
          }
        }
      }
    });
  },

  async install() {
    await withBoundRuntimes(async (runtimes, reused) => {
      const path = resolveConfigPath();
      const document = readConfig(path);
      if (isManaged(document) && !flags.has("--force")) {
        // Re-running install refreshes ports and catalogs, which is the normal path.
        log(`refreshing existing configuration in ${path}`);
      }

      // Effort probing costs one request per level per model, so it is opt-in.
      if (flags.has("--probe-efforts") && !reused) {
        for (const runtime of runtimes) {
          await runtime.probeEfforts({ force: flags.has("--force-probe") });
        }
      }

      const providers = {};
      for (const runtime of runtimes) {
        providers[runtime.providerId] = await runtime.providerBlock();
      }

      const first = runtimes[0];
      // With a live catalog, default to the first real model. When reusing a
      // running relay the catalog is not at hand, so an existing default that
      // still points at this provider is kept rather than guessed at.
      const preferred = first.models.find((model) => model.id !== "default");
      const existingDefault =
        typeof document["model"] === "string" && document["model"].startsWith(`${first.providerId}/`)
          ? document["model"]
          : undefined;
      const defaultModel =
        preferred === undefined ? existingDefault : `${first.providerId}/${preferred.id}`;

      const next = applyProviders(document, providers, defaultModel);
      writeConfig(path, next);
      log(`wrote ${Object.keys(providers).length} provider(s) to ${path}`);
      if (defaultModel !== undefined) log(`default model set to ${defaultModel}`);
      if (json) {
        process.stdout.write(
          `${JSON.stringify({ path, providers: Object.keys(providers), defaultModel, reusedRunningRelay: reused }, null, 2)}\n`,
        );
      }
    });
  },

  async uninstall() {
    const path = resolveConfigPath();
    const document = readConfig(path);
    if (!isManaged(document) && document["provider"] === undefined) {
      log(`nothing to remove in ${path}`);
      return;
    }
    writeConfig(path, removeProviders(document));
    log(`removed mimo-workbuddy-connect configuration from ${path}`);
  },

  /**
   * Diagnose the whole chain: app sign-in, at-rest key resolution, upstream
   * catalog, and the generated configuration. Each check reports a concrete
   * next action when it fails, so a broken install is fixable without guessing.
   */
  async doctor() {
    const { authCandidatesFor, VARIANTS } = await import("./auth.js");
    const { electronCandidates } = await import("./protection.js");
    const checks = [];

    const variant = VARIANTS[selectedVariants[0]];
    const candidates = authCandidatesFor(variant);
    const found = candidates.find((p) => existsSync(p));
    checks.push({
      name: "WorkBuddy auth file",
      ok: found !== undefined,
      detail: found ?? `not found; looked in ${candidates.join(", ")}`,
      fix: found === undefined ? "install and sign in to the WorkBuddy desktop app" : undefined,
    });

    const binaries = electronCandidates();
    checks.push({
      name: "WorkBuddy Electron binary (for encrypted tokens)",
      ok: binaries.length > 0,
      detail: binaries[0] ?? "not found",
      fix: binaries.length === 0 ? "set WORKBUDDY_ELECTRON_BIN to the WorkBuddy executable" : undefined,
    });

    const configPath = resolveConfigPath();
    checks.push({
      name: "MiMoCode config path",
      ok: true,
      detail: configPath,
    });

    await withPreparedRuntimes(async (runtimes) => {
      for (const runtime of runtimes) {
        const status = runtime.describe();
        checks.push({
          name: `${status.displayName} sign-in`,
          ok: status.signedIn,
          detail: status.signedIn ? `${status.source}${status.account ? `, account ${status.account}` : ""}` : status.error,
          fix: status.signedIn ? undefined : "sign in to the WorkBuddy app, then re-run",
        });
        checks.push({
          name: `${status.displayName} model catalog`,
          ok: status.models > 0,
          detail: `${status.models} models (${status.catalogSource})${status.catalogError ? ` — ${status.catalogError}` : ""}`,
          fix: status.models > 0 ? undefined : "check the network, then re-run install",
        });
      }

      const document = existsSync(configPath) ? readConfig(configPath) : {};
      // The config must satisfy MiMoCode's schema; an unknown key makes the app
      // reject the entire file with "配置文件有误", so this is checked explicitly.
      const problems = validateConfigDocument(document);
      checks.push({
        name: "config passes MiMoCode schema validation",
        ok: problems.length === 0,
        detail:
          problems.length === 0
            ? `${Object.keys(document["provider"] ?? {}).length} provider block(s) valid`
            : problems.slice(0, 3).join("; ") + (problems.length > 3 ? ` (+${problems.length - 3} more)` : ""),
        fix: problems.length === 0 ? undefined : "run: node src/cli.js install (regenerates a valid config)",
      });

      const configured = runtimes.every((r) => document["provider"]?.[r.providerId] !== undefined);
      checks.push({
        name: "provider written to MiMoCode config",
        ok: configured,
        detail: configured ? Object.keys(document["provider"]).join(", ") : "not present",
        fix: configured ? undefined : "run: node src/cli.js install",
      });

      // Check the relay the configuration actually points at, not a probe port.
      for (const runtime of runtimes) {
        const expectedPort = runtime.providerId === PROVIDER_ID_AI ? DEFAULT_PORTS.ai : DEFAULT_PORTS.cn;
        const block = document["provider"]?.[runtime.providerId];
        const actual = block?.options?.baseURL ?? "";
        const expectedUrl = `http://127.0.0.1:${expectedPort}/v1`;
        const urlOk = actual === expectedUrl;
        checks.push({
          name: `${runtime.variant.displayName} configured relay URL`,
          ok: urlOk,
          detail: actual || "not configured",
          fix: urlOk ? undefined : `expected ${expectedUrl}; run: node src/cli.js install`,
        });

        const live = await relayAlreadyRunning(expectedPort);
        checks.push({
          name: `${runtime.variant.displayName} relay is serving on port ${expectedPort}`,
          ok: live,
          detail: live ? `http://127.0.0.1:${expectedPort}/health answered` : "no response",
          fix: live ? undefined : "run: scripts\\install.ps1 (or start it with scripts\\relay-hidden.cmd)",
        });
      }
    });

    const failed = checks.filter((c) => !c.ok);
    if (json) {
      process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, checks }, null, 2)}\n`);
      return;
    }
    for (const check of checks) {
      process.stdout.write(`  ${check.ok ? "ok  " : "FAIL"}  ${check.name}\n`);
      if (check.detail) process.stdout.write(`          ${check.detail}\n`);
      if (check.fix) process.stdout.write(`          fix: ${check.fix}\n`);
    }
    process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
    if (failed.length > 0) process.exitCode = 1;
  },

  /**
   * Re-fetch the catalog from upstream and rewrite the provider config.
   *
   * Refreshing needs a live upstream catalog, so this always probes fresh; a
   * relay already holding the port is stopped first, then restarted by the
   * caller's normal autostart path.
   */
  async refresh() {
    const ports = selectedVariants.map((id) => (id === "ai" ? DEFAULT_PORTS.ai : DEFAULT_PORTS.cn));
    if ((await Promise.all(ports.map(relayAlreadyRunning))).some(Boolean)) {
      // A running relay is started through the same code path as install; ask
      // the user to reinstall rather than silently killing their relay.
      throw new Error(
        "a relay is already running and holds the port; stop it first (or re-run install, " +
          "which refreshes configuration against the running instance)",
      );
    }
    await withRuntimes(async (runtimes) => {
      const path = resolveConfigPath();
      const document = readConfig(path);
      const providers = {};
      for (const runtime of runtimes) providers[runtime.providerId] = runtime.providerBlock();
      const next = applyProviders(document, providers, document["model"]);
      writeConfig(path, next);
      for (const runtime of runtimes) {
        log(`${runtime.variant.displayName}: ${runtime.models.length} models refreshed`);
      }
      log(`updated ${path}`);
    });
  },

  async serve() {
    const port = process.env["MIMO_WORKBUDDY_PORT"];
    const runtimes = await startAll({
      variants: selectedVariants,
      ...(port === undefined ? {} : { port: Number(port) }),
      log,
    });
    const shutdown = async () => {
      for (const runtime of runtimes) await runtime.stop();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    for (const runtime of runtimes) {
      const status = runtime.describe();
      log(`${status.displayName}: http://127.0.0.1:${status.port}/v1 (${status.models} models)`);
    }
  },
};

const handler = commands[command];
if (handler === undefined) {
  process.stderr.write(`unknown command: ${command}\n`);
  process.stderr.write(`usage: node src/cli.js <${Object.keys(commands).join("|")}> [--json] [--provider=cn|ai]\n`);
  process.exit(2);
}
await handler();
