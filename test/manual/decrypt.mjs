// Verifies at-rest decryption against this machine's real WorkBuddy auth file.
import { readFileSync } from "node:fs";
import { VARIANTS, authCandidatesFor } from "../../src/auth.js";
import { decryptAuthDocument, electronCandidates, parseWrappedField } from "../../src/protection.js";

const path = authCandidatesFor(VARIANTS.cn)[0];
console.log("auth file:", path);
console.log("electron candidates:", electronCandidates());

const document = JSON.parse(readFileSync(path, "utf8"));
const envelope = parseWrappedField(document.auth.accessToken);
console.log("envelope ok:", envelope !== undefined, envelope ? `keyId=${envelope.keyId} suite=${envelope.suite}` : "");

const started = Date.now();
const { decryptedFields } = await decryptAuthDocument(document);
console.log(`decrypted fields: ${decryptedFields.join(", ")} (${Date.now() - started}ms)`);
console.log("accessToken length:", document.auth.accessToken.length);
console.log("refreshToken length:", document.auth.refreshToken.length);
console.log("accessToken looks like a token:", /^[\x20-\x7E]+$/.test(document.auth.accessToken));
console.log("uid:", document.account?.uid);
console.log("domain:", document.auth.domain ?? "(none)");
