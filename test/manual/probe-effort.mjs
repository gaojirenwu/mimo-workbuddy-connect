// Probes real effort acceptance for models that do not declare their levels.
import { WorkBuddyUpstreamClient } from "../../src/upstream.js";
import { CredentialSession, VARIANTS } from "../../src/index.js";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

const upstream = new WorkBuddyUpstreamClient();
const session = new CredentialSession({ variant: VARIANTS.cn, upstream, log: () => {} });
if (!(await session.ensureCredential())) {
  console.log("not signed in");
  process.exit(1);
}

const models = await upstream.fetchModels(session.credential);
const targets = (process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : models.filter((m) => m.reasoning?.supports && !m.reasoning.supportedEfforts?.length).map((m) => m.id).slice(0, 4)
);

console.log("probing:", targets.join(", "), "\n");
for (const id of targets) {
  const accepted = [];
  const rows = [];
  for (const effort of EFFORTS) {
    const verdict = await upstream.probeEffort(session.credential, id, effort);
    if (verdict === "accepted") accepted.push(effort);
    rows.push(`${effort}=${verdict}`);
  }
  console.log(`${id}\n  ${rows.join("  ")}\n  => accepted: ${accepted.length ? accepted.join("/") : "(none)"}\n`);
}
process.exit(0);
