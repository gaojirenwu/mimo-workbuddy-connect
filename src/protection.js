/**
 * WorkBuddy at-rest credential protection (5.6+).
 *
 * Since WorkBuddy 5.6 both desktop apps encrypt `auth.accessToken` and
 * `auth.refreshToken` at rest, so the auth file carries
 * `{$wbEncrypted:1, envelope}` wrappers instead of token strings. Everything
 * needed to open them lives on the same machine:
 *
 * - the sealed payload (`{version:1, atRestSecretKey}`) comes from the
 *   WorkBuddy-modified Electron's private `workbuddyStorage` binding, reached
 *   by running *its own* binary once with `ELECTRON_RUN_AS_NODE=1`;
 * - `protectorKey = sha256(atRestSecretKey, utf8)` opens the envelopes with
 *   AES-256-GCM under a fixed AAD.
 *
 * Ported from `dsh-workbuddy-connect`'s `desktop-credential-protection.ts`. The
 * plugin process cannot call `_linkedBinding` itself, so the app binary is
 * spawned as a helper. The key is cached in memory only and is never logged;
 * error messages carry sizes and exit codes, never key material.
 *
 * @module mimo-workbuddy-connect/protection
 */
import { execFile } from "node:child_process";
import { createDecipheriv, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** The one-line helper: print the sealed payload, nothing else. */
const HELPER_SCRIPT =
  'process.stdout.write(String(process._linkedBinding("electron_browser_workbuddy_storage").loggerGet()))';

/** Field names that may be encrypted at rest. */
const AUTH_FIELDS = ["accessToken", "refreshToken"];

/**
 * The authenticated-context AAD for one field envelope, transcribed from the
 * app bundle's `buildAuthenticatedContextAad`. Credential fields are always
 * suite 1 under the `field` framing (WBEV1).
 */
export function buildAuthenticatedContextAad(keyId, suite) {
  const lengthPrefixed = (value) => {
    const bytes = Buffer.from(value, "utf8");
    const header = Buffer.allocUnsafe(4);
    header.writeUInt32BE(bytes.length);
    return Buffer.concat([header, bytes]);
  };
  const suiteBytes = Buffer.allocUnsafe(4);
  suiteBytes.writeUInt32BE(suite);
  return Buffer.concat([
    Buffer.from("WB-AAD\0", "ascii"),
    Buffer.from([1]),
    lengthPrefixed("WBEV1"),
    lengthPrefixed("sym-v1"),
    suiteBytes,
    lengthPrefixed(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ]);
}

/** Decode base64 and check the exact byte length when given. */
function parseBase64(value, length) {
  if (typeof value !== "string" || value === "") return undefined;
  let decoded;
  try {
    decoded = Buffer.from(value, "base64");
  } catch {
    return undefined;
  }
  if (decoded.length === 0) return undefined;
  if (decoded.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) return undefined;
  return length === undefined || decoded.length === length ? decoded : undefined;
}

/** Parse a `{$wbEncrypted:1, envelope}` wrapper into its envelope, or undefined. */
export function parseWrappedField(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  if (value["$wbEncrypted"] !== 1 || typeof value["envelope"] !== "string") return undefined;
  let inner;
  try {
    inner = JSON.parse(Buffer.from(value["envelope"], "base64").toString("utf8"));
  } catch {
    return undefined;
  }
  if (typeof inner !== "object" || inner === null || Array.isArray(inner)) return undefined;
  const nonce = parseBase64(inner["nonce"], 12);
  const authTag = parseBase64(inner["authTag"], 16);
  const ciphertext = parseBase64(inner["ciphertext"]);
  if (nonce === undefined || authTag === undefined || ciphertext === undefined) return undefined;
  if (typeof inner["suite"] !== "number" || !Number.isInteger(inner["suite"])) return undefined;
  if (inner["suite"] !== 1) return undefined;
  if (typeof inner["keyId"] !== "string" || !/^[0-9a-f]{16}$/u.test(inner["keyId"])) return undefined;
  return { suite: inner["suite"], keyId: inner["keyId"], nonce, authTag, ciphertext };
}

/** Validate the helper's payload against the app's own rules. */
export function parseAtRestPayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  if (parsed["version"] !== 1) return undefined;
  const secret = parsed["atRestSecretKey"];
  if (typeof secret !== "string" || secret === "") return undefined;
  const decoded = parseBase64(secret, 32);
  if (decoded === undefined) return undefined;
  if (decoded.every((byte) => byte === 0)) return undefined;
  return { atRestSecretKey: secret };
}

/** Derive the protector key from the payload's secret. */
export function deriveProtectorKey(secret) {
  return createHash("sha256").update(secret, "utf8").digest();
}

/** Open one envelope with a protector key; undefined when it will not open. */
export function openAuthField(key, envelope) {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, envelope.nonce, { authTagLength: 16 });
    decipher.setAAD(buildAuthenticatedContextAad(envelope.keyId, envelope.suite));
    decipher.setAuthTag(envelope.authTag);
    return Buffer.concat([decipher.update(envelope.ciphertext), decipher.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Candidate Electron binaries for the WorkBuddy app, in probe order.
 *
 * The CN build has a verified default location; a user override always wins.
 * The international build has no verified default, so only the override and
 * registry discovery are offered for it.
 */
export function electronCandidates() {
  const candidates = [];
  const override = process.env["WORKBUDDY_ELECTRON_BIN"]?.trim();
  if (override) candidates.push(override);

  if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"]?.trim();
    if (local) candidates.push(join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"));
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/WorkBuddy.app/Contents/MacOS/WorkBuddy");
  }
  return candidates.filter((path) => existsSync(path));
}

/** Spawn the app binary as Node and read the sealed payload. */
function spawnHelper(electronPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      ["-e", HELPER_SCRIPT],
      {
        timeout: timeoutMs,
        maxBuffer: 1 << 20,
        windowsHide: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
      (error, stdout) => {
        if (error != null) {
          reject(new Error(`key helper (${electronPath}) could not be run: ${error.code ?? error.message}`));
          return;
        }
        const output = String(stdout).trim();
        if (output === "") {
          reject(new Error(`key helper (${electronPath}) produced no payload`));
          return;
        }
        resolve(output);
      },
    );
  });
}

/** In-memory, single-flight key cache. Never written to disk, never logged. */
let cachedKey;
let keyPromise;
let cachedKeyId;

/** Resolve the protector key, spawning the helper at most once per key id. */
export async function resolveProtectorKey(keyId, options = {}) {
  if (cachedKey !== undefined && (cachedKeyId === undefined || keyId === undefined || cachedKeyId === keyId)) {
    return cachedKey;
  }
  if (keyPromise !== undefined) return keyPromise;

  const timeoutMs = options.timeoutMs ?? 15_000;
  keyPromise = (async () => {
    const candidates = options.electronPaths ?? electronCandidates();
    if (candidates.length === 0) {
      throw new Error(
        "the WorkBuddy app's Electron binary could not be located; set WORKBUDDY_ELECTRON_BIN to it",
      );
    }
    let lastError;
    for (const candidate of candidates) {
      try {
        const payload = parseAtRestPayload(await spawnHelper(candidate, timeoutMs));
        if (payload === undefined) {
          lastError = new Error(`key helper (${candidate}) returned an unusable payload`);
          continue;
        }
        const key = deriveProtectorKey(payload.atRestSecretKey);
        cachedKey = key;
        cachedKeyId = keyId;
        return key;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("no WorkBuddy Electron binary produced a usable key");
  })().finally(() => {
    keyPromise = undefined;
  });
  return keyPromise;
}

/** Drop the cached key, so the next read re-derives it. */
export function clearKeyCache() {
  cachedKey = undefined;
  cachedKeyId = undefined;
}

/**
 * Decrypt the token fields of a parsed auth document in place.
 *
 * @returns {{document: object, decryptedFields: string[]}}
 * @throws when a wrapped field cannot be opened.
 */
export async function decryptAuthDocument(document, options = {}) {
  const auth =
    typeof document["auth"] === "object" && document["auth"] !== null ? document["auth"] : document;
  const wrapped = [];
  for (const field of AUTH_FIELDS) {
    const envelope = parseWrappedField(auth[field]);
    if (envelope !== undefined) wrapped.push({ field, envelope });
  }
  if (wrapped.length === 0) return { document, decryptedFields: [] };

  const keyId = wrapped[0].envelope.keyId;
  const key = await resolveProtectorKey(keyId, options);
  const decryptedFields = [];
  for (const { field, envelope } of wrapped) {
    const plaintext = openAuthField(key, envelope);
    if (plaintext === undefined) {
      // A wrong key is the likeliest cause and must never be silently ignored.
      clearKeyCache();
      throw new Error(
        `could not decrypt "${field}" (keyId ${keyId}); the stored key did not open this document`,
      );
    }
    auth[field] = plaintext;
    decryptedFields.push(field);
  }
  return { document, decryptedFields };
}

export const internals = { HELPER_SCRIPT, AUTH_FIELDS };
