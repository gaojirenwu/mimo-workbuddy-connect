/**
 * WorkBuddy desktop credential discovery and parsing.
 *
 * Ported from `dsh-workbuddy-connect`'s `desktop-auth.ts` /
 * `parseWorkBuddyAuth` so MiMo Desktop can reuse the WorkBuddy app's existing
 * sign-in instead of starting its own OAuth flow. Nothing here is
 * WorkBuddy-specific beyond the file locations and the document shape.
 *
 * @module mimo-workbuddy-connect/auth
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Both WorkBuddy products write into the same shared auth directory. */
const DESKTOP_AUTH_RELATIVE_PATH = [
  "CodeBuddyExtension",
  "Data",
  "Public",
  "auth",
];

/** Auth-file basename per variant (CN and international differ only here). */
export const VARIANTS = {
  cn: {
    id: "cn",
    displayName: "WorkBuddy",
    desktopFilename: "workbuddy-desktop.info",
    ownFilename: ".workbuddy-auth.json",
    catalogFilename: ".workbuddy-catalog.json",
    probeFilename: ".workbuddy-probe.json",
    authFileEnv: "WORKBUDDY_AUTH_FILE",
  },
  ai: {
    id: "ai",
    displayName: "WorkBuddy AI",
    desktopFilename: "workbuddy-ai-desktop.info",
    ownFilename: ".workbuddy-ai-auth.json",
    catalogFilename: ".workbuddy-ai-catalog.json",
    probeFilename: ".workbuddy-ai-probe.json",
    authFileEnv: "WORKBUDDY_AI_AUTH_FILE",
  },
};

/** Platform-default candidates for the shared auth directory, in probe order. */
function defaultAuthDirs() {
  const home = homedir();
  if (process.platform === "darwin") {
    return [
      join(home, "Library", "Application Support", "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  if (process.platform === "win32") {
    return [
      join(home, "AppData", "Local", "CodeBuddyExtension", "Data", "Public", "auth"),
      join(home, "AppData", "Roaming", "CodeBuddyExtension", "Data", "Public", "auth"),
    ];
  }
  const configHome = process.env["XDG_CONFIG_HOME"] || join(home, ".config");
  const dataHome = process.env["XDG_DATA_HOME"] || join(home, ".local", "share");
  return [
    join(configHome, ...DESKTOP_AUTH_RELATIVE_PATH),
    join(dataHome, ...DESKTOP_AUTH_RELATIVE_PATH),
  ];
}

/** Candidate auth-file paths for one variant, in probe order. */
export function authCandidatesFor(variant) {
  const listed = defaultAuthDirs().map((dir) => join(dir, variant.desktopFilename));
  const override = process.env[variant.authFileEnv]?.trim();
  return override ? [override, ...listed] : listed;
}

/** Normalize an expiry that may arrive in seconds or milliseconds. */
function expiryToMs(value) {
  if (typeof value !== "number" || value <= 0) return 0;
  // Anything past ~year 9999 in seconds must already be milliseconds.
  return value > 8.64e15 / 1e3 ? value : value * 1000;
}

function optionalString(value) {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/**
 * Parse a WorkBuddy auth document.
 *
 * Handles both on-disk shapes: the nested `{auth:{...}, account:{...}}` form and
 * the flat form. Since WorkBuddy 5.6 the token fields may instead be
 * `{$wbEncrypted:1, envelope}` wrappers, which the caller must decrypt first —
 * this function only reads plaintext strings and reports `undefined` when no
 * usable access token is present.
 *
 * @returns {object|undefined} credential, or undefined when unusable.
 */
export function parseWorkBuddyAuth(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const document = parsed;
  let auth;
  let identity;
  if (typeof document["auth"] === "object" && document["auth"] !== null) {
    auth = document["auth"];
    identity =
      typeof document["account"] === "object" && document["account"] !== null
        ? document["account"]
        : {};
  } else {
    auth = document;
    identity = document;
  }

  const accessToken = typeof auth["accessToken"] === "string" ? auth["accessToken"] : "";
  const encrypted = isEncryptedField(auth["accessToken"]) || isEncryptedField(auth["refreshToken"]);

  return {
    accessToken,
    refreshToken: typeof auth["refreshToken"] === "string" ? auth["refreshToken"] : "",
    expiresAtMs: expiryToMs(auth["expiresAt"]),
    domain: optionalString(auth["domain"]) ?? "",
    uid: optionalString(identity["uid"]) ?? "",
    enterpriseId: optionalString(identity["enterpriseId"]),
    nickname: optionalString(identity["nickname"]),
    /** True when at-rest protection is in play and decryption is required. */
    encrypted,
    /** Raw wrappers, for callers that can decrypt. */
    rawAuth: auth,
  };
}

/** Whether a field is the WorkBuddy 5.6 `{$wbEncrypted:1, envelope}` wrapper. */
export function isEncryptedField(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    value["$wbEncrypted"] === 1 &&
    typeof value["envelope"] === "string"
  );
}

/**
 * Classify a desktop auth document into a readable format label, so failures
 * are reported as "not signed in" versus "encrypted, needs the app's key"
 * rather than as a generic parse error.
 */
export function classifyAuthDocument(text) {
  if (text.trim() === "") return "absent";
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "unrecognized";
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "unrecognized";
  }
  const auth = typeof parsed["auth"] === "object" && parsed["auth"] !== null ? parsed["auth"] : parsed;
  if (isEncryptedField(auth["accessToken"]) || isEncryptedField(auth["refreshToken"])) {
    return "encrypted";
  }
  return "plaintext";
}

/**
 * Read and parse the first usable WorkBuddy auth file for one variant.
 *
 * Encrypted documents (WorkBuddy 5.6+) are opened transparently via
 * {@link decryptAuthDocument}, which runs the app's own binary once to obtain
 * the at-rest key; the key stays in memory and is never written to disk.
 *
 * @returns {Promise<{credential: object, path: string}|{error: string, path?: string, format?: string}>}
 */
export async function readWorkBuddyCredentialAsync(variant) {
  const candidates = authCandidatesFor(variant);
  let sawEncrypted;
  let lastFormat;
  let decryptError;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return { error: `auth file unreadable: ${error.message}`, path };
    }
    const format = classifyAuthDocument(text);
    lastFormat = format;
    if (format === "encrypted") {
      sawEncrypted = sawEncrypted ?? path;
      // Attempt decryption once, on the first encrypted candidate.
      if (decryptError === undefined) {
        try {
          const document = JSON.parse(text);
          const { decryptAuthDocument } = await import("./protection.js");
          await decryptAuthDocument(document);
          const credential = parseWorkBuddyAuth(JSON.stringify(document));
          if (credential !== undefined && credential.accessToken !== "") {
            return { credential, path, decrypted: true };
          }
        } catch (error) {
          decryptError = error;
        }
      }
      continue;
    }
    const credential = parseWorkBuddyAuth(text);
    if (credential !== undefined && credential.accessToken !== "") {
      return { credential, path };
    }
  }
  if (sawEncrypted !== undefined) {
    return {
      error:
        decryptError !== undefined
          ? `WorkBuddy stores its tokens encrypted and they could not be opened: ${decryptError.message}`
          : "WorkBuddy stores its tokens encrypted and no key was available",
      path: sawEncrypted,
      format: "encrypted",
    };
  }
  if (lastFormat === "absent" || lastFormat === undefined) {
    return { error: `no WorkBuddy auth file found (${candidates[0]})`, format: lastFormat };
  }
  return {
    error: "auth file carried no access token — sign in to the WorkBuddy app",
    format: lastFormat,
  };
}

/**
 * Synchronous variant of {@link readWorkBuddyCredentialAsync}.
 *
 * Plaintext documents are handled directly; encrypted documents cannot be
 * opened synchronously, so they report the encrypted error rather than a
 * misleading "not signed in".
 */
export function readWorkBuddyCredential(variant) {
  const candidates = authCandidatesFor(variant);
  let sawEncrypted;
  let lastFormat;
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      return { error: `auth file unreadable: ${error.message}`, path };
    }
    const format = classifyAuthDocument(text);
    lastFormat = format;
    if (format === "encrypted") {
      sawEncrypted = sawEncrypted ?? path;
      continue;
    }
    const credential = parseWorkBuddyAuth(text);
    if (credential !== undefined && credential.accessToken !== "") {
      return { credential, path };
    }
  }
  if (sawEncrypted !== undefined) {
    return {
      error: "WorkBuddy stores its tokens encrypted at rest; use the asynchronous reader to open them",
      path: sawEncrypted,
      format: "encrypted",
    };
  }
  if (lastFormat === "absent" || lastFormat === undefined) {
    return { error: `no WorkBuddy auth file found (${candidates[0]})`, format: lastFormat };
  }
  return {
    error: "auth file carried no access token — sign in to the WorkBuddy app",
    format: lastFormat,
  };
}

/** Directory holding the plugin's own state, separate from the app's files. */
export function stateDir() {
  const base = process.env["MIMO_WORKBUDDY_HOME"]?.trim();
  if (base) return base;
  const appData =
    process.env["APPDATA"] ||
    process.env["XDG_STATE_HOME"] ||
    join(homedir(), ".local", "state");
  return join(appData, "mimo-workbuddy-connect");
}

/** Path of one plugin-owned state file. */
export function statePath(filename) {
  return join(stateDir(), filename);
}

/** Exported for tests and diagnostics. */
export const internals = { defaultAuthDirs, expiryToMs, dirname };
