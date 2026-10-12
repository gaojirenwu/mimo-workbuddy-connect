#!/usr/bin/env node
/**
 * Cross-platform installer for mimo-workbuddy-connect.
 *
 * Writes the MiMoCode provider configuration and, optionally, registers the
 * relay to start automatically. Windows delegates autostart to the registry
 * (see `install.ps1`); macOS and Linux use a launchd agent and a systemd user
 * unit respectively.
 *
 *   node scripts/install.mjs                install + autostart
 *   node scripts/install.mjs --no-autostart install only
 *   node scripts/install.mjs --uninstall    remove both
 *   node scripts/install.mjs --provider=cn|ai|both
 *
 * @module mimo-workbuddy-connect/install
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pluginDir = resolve(here, "..");
const cliPath = join(pluginDir, "src", "cli.js");

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const variantArg = args.find((a) => a.startsWith("--provider="));
const provider = variantArg ? variantArg.slice("--provider=".length) : "cn";
const label = "com.mimo-workbuddy-connect";

const log = (message) => process.stdout.write(`${message}\n`);
const step = (message) => process.stdout.write(`\n==> ${message}\n`);

/** Run the plugin CLI in-process's sibling, inheriting stdio. */
function runCli(...cliArgs) {
  execFileSync(process.execPath, [cliPath, ...cliArgs], { stdio: "inherit" });
}

/** Where each platform keeps a user-level autostart definition. */
function autostartTarget() {
  const home = homedir();
  if (process.platform === "darwin") {
    return join(home, "Library", "LaunchAgents", `${label}.plist`);
  }
  if (process.platform === "linux") {
    return join(home, ".config", "systemd", "user", `${label}.service`);
  }
  return undefined;
}

/** Write the platform autostart file, replacing any previous copy. */
function writeAutostart() {
  if (process.platform === "win32") {
    log("    Windows: run scripts\\install.ps1 to register the logon task");
    return false;
  }
  const target = autostartTarget();
  if (target === undefined) return false;
  mkdirSync(dirname(target), { recursive: true });

  const logDir = join(
    homedir(),
    process.platform === "darwin" ? "Library/Logs" : ".local/state",
  );
  mkdirSync(logDir, { recursive: true });
  const logFile = join(logDir, "mimo-workbuddy-connect.log");

  if (process.platform === "darwin") {
    // launchd resolves no PATH of its own, so node is addressed absolutely.
    writeFileSync(
      target,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${process.execPath}</string>
    <string>${cliPath}</string>
    <string>serve</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logFile}</string>
  <key>StandardErrorPath</key><string>${logFile}</string>
</dict>
</plist>
`,
      "utf8",
    );
    try {
      execFileSync("launchctl", ["unload", target], { stdio: "ignore" });
    } catch {
      /* not loaded yet */
    }
    execFileSync("launchctl", ["load", target], { stdio: "inherit" });
    log(`    launchd agent installed: ${target}`);
    return true;
  }

  writeFileSync(
    target,
    `[Unit]
Description=WorkBuddy models relay for MiMo Desktop
After=network-online.target

[Service]
ExecStart=${process.execPath} ${cliPath} serve
Restart=always
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`,
    "utf8",
  );
  try {
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", `${label}.service`], { stdio: "inherit" });
    log(`    systemd user unit installed: ${target}`);
  } catch {
    log(`    wrote ${target}; enable it with: systemctl --user enable --now ${label}.service`);
  }
  return true;
}

/** Stop and remove the autostart definition. */
function removeAutostart() {
  const target = autostartTarget();
  if (process.platform === "darwin" && target !== undefined) {
    try {
      execFileSync("launchctl", ["unload", target], { stdio: "ignore" });
    } catch {
      /* not loaded */
    }
  }
  if (process.platform === "linux") {
    try {
      execFileSync("systemctl", ["--user", "disable", "--now", `${label}.service`], { stdio: "ignore" });
    } catch {
      /* not enabled */
    }
  }
  if (target !== undefined && existsSync(target)) {
    rmSync(target, { force: true });
    log(`    removed ${target}`);
  }
}

// ---------------------------------------------------------------- uninstall
if (flags.has("--uninstall")) {
  step("Removing autostart");
  removeAutostart();
  step("Removing the MiMoCode provider configuration");
  runCli("uninstall");
  log("\nUninstalled. Restart MiMo Desktop to drop the WorkBuddy models.");
  process.exit(0);
}

// ------------------------------------------------------------------ install
step(`Checking the WorkBuddy sign-in (provider=${provider})`);
runCli("status", `--provider=${provider}`);

step("Writing the MiMoCode provider configuration");
runCli("install", `--provider=${provider}`);

if (!flags.has("--no-autostart")) {
  step("Registering autostart");
  writeAutostart();
} else {
  step("Skipping autostart (--no-autostart)");
  log("    start it manually with: node src/cli.js serve");
}

step("Diagnosing");
try {
  runCli("doctor", `--provider=${provider}`);
} catch {
  log("    doctor reported problems; see the output above");
}

log("\nInstalled.");
log("  1. Restart MiMo Desktop so it re-reads the configuration.");
log("  2. The WorkBuddy models appear in the model picker.");
