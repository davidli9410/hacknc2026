// Foodie server: migrations, clock, jobs, Spectrum (iMessage + terminal), web, scheduler.
import { loadClock } from "./clock.ts";
import { config, hasGemini, hasGoogleOAuth, hasMaps, hasNessie, hasPhoton } from "./config.ts";
import { db, runMigrations } from "./db/index.ts";
import { seedDemo } from "./demo/seed.ts";
import { registerJobs } from "./jobs.ts";
import { startSpectrum, stopSpectrum } from "./integrations/photon.ts";
import { routeInbound } from "./router.ts";
import { startScheduler, stopScheduler } from "./scheduler.ts";
import { startWeb } from "./web/server.ts";

await runMigrations();
await loadClock();
registerJobs();

if (config.demo) {
  const anyone = await db.query.users.findFirst();
  if (!anyone) {
    await seedDemo();
    console.log("[demo] seeded Ronald and Clive; Eric starts with nothing");
  }
}

const server = startWeb();
const spectrum = await startSpectrum(routeInbound);
startScheduler();

const status = (ok: boolean) => (ok ? "on" : "off");
console.log(
  [
    `Foodie on ${config.publicBaseUrl} (port ${server.port})`,
    `iMessage ${status(hasPhoton())} · terminal ${status(config.terminal)} · Gemini ${status(hasGemini())} · Google ${status(hasGoogleOAuth())} · Maps ${status(hasMaps())} · Nessie ${hasNessie() ? "on" : "in-memory"} · demo ${status(config.demo)}`,
    spectrum ? "" : "No message providers configured: set PHOTON_* for iMessage or TERMINAL=1 for the terminal.",
  ]
    .filter(Boolean)
    .join("\n"),
);

const shutdown = async () => {
  stopScheduler();
  await stopSpectrum();
  server.stop();
  process.exit(0);
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
