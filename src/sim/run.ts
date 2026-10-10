// `bun run sim`: plays Ronald, Clive and Eric through every section 9 transcript in one terminal.
import { prepareSimEnv } from "./env.ts";

await prepareSimEnv(process.env.SIM_DATABASE ?? "foodie_sim");
const { runScenarios } = await import("./scenarios.ts");
const { closeDb } = await import("../db/index.ts");

const only = process.argv[2];
const checks = await runScenarios(true, only);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} transcript checks passed.`);
await closeDb();
process.exit(failed.length ? 1 : 0);
