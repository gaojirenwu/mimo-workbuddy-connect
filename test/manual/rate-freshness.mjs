// Answers: is the credit multiplier in the config live, or a snapshot?
//
// 1. Reads the rate currently written into the MiMoCode config.
// 2. Fetches the rate straight from the upstream catalog right now.
// 3. Reports how often the relay refreshes its own catalog.
import { readFileSync } from "node:fs";
import { parseJsonc } from "../../src/provider.js";
import { CredentialSession, VARIANTS, WorkBuddyUpstreamClient } from "../../src/index.js";

const configPath = process.env.USERPROFILE + "\\.config\\mimocode\\mimocode.jsonc";
const config = JSON.parse(parseJsonc(readFileSync(configPath, "utf8")));
const configured = config.provider.workbuddy.models;

const upstream = new WorkBuddyUpstreamClient();
const session = new CredentialSession({ variant: VARIANTS.cn, upstream, log: () => {} });
await session.ensureCredential();
const live = await upstream.fetchModels(session.credential);

console.log("model".padEnd(22) + "in config".padEnd(14) + "upstream now");
console.log("-".repeat(58));
let same = 0;
let different = 0;
for (const model of live.slice(0, 12)) {
  const wrote = configured[model.id]?.name ?? "(absent)";
  const label = model.billing?.credits ?? "";
  const hasRate = /x\d/.test(wrote);
  const expected = label ? `${model.name} · ${label.replace(/\s+credits$/iu, "")}` : model.name;
  const match = hasRate && wrote === expected;
  if (model.id in configured) match ? same++ : different++;
  console.log(model.id.padEnd(22) + wrote.replace(model.name, "").padEnd(14) + (label || "(none)") + (match ? "" : "   <-- differs"));
}
console.log(`\nmatching rates: ${same}, differing: ${different}`);

// How fresh is the config versus the upstream?
const cfgAge = (Date.now() - (await import("node:fs")).statSync(configPath).mtimeMs) / 60000;
console.log(`config age: ${cfgAge.toFixed(1)} min`);
process.exit(0);
