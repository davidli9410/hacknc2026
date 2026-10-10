// Puts the process in sim mode before any app module reads config: its own database, demo data,
// no Gemini, no Photon, an in-memory bank. Nothing leaves the machine.
import postgres from "postgres";

export async function prepareSimEnv(dbName: string): Promise<void> {
  const base = process.env.SIM_DATABASE_ADMIN_URL ?? "postgres://localhost:5432/postgres";
  const url = new URL(base);
  url.pathname = `/${dbName}`;
  Object.assign(process.env, {
    DATABASE_URL: url.toString(),
    DEMO: "1",
    USE_GEMINI: "0",
    TERMINAL: "0",
    PUBLIC_BASE_URL: "https://foodie.example",
    DEMO_DATE: "2026-10-10",
    TIMEZONE: "America/New_York",
    DEMO_ORGANIZER: "Ronald",
    DEMO_MEMBER: "Clive",
    DEMO_NEWCOMER: "Eric",
  });
  for (const key of ["PHOTON_PROJECT_ID", "PHOTON_PROJECT_SECRET", "NESSIE_API_KEY", "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_MAPS_API_KEY", "GEMINI_API_KEY", "DEMO_PHONES"]) {
    delete process.env[key];
  }
  const admin = postgres(base, { onnotice: () => {} });
  try {
    const rows = await admin`select 1 from pg_database where datname = ${dbName}`;
    if (rows.length === 0) await admin.unsafe(`create database "${dbName}"`);
  } finally {
    await admin.end();
  }
  const { runMigrations } = await import("../db/index.ts");
  await runMigrations();
  const { registerJobs } = await import("../jobs.ts");
  registerJobs();
  const { setClock } = await import("../clock.ts");
  const { zonedDate } = await import("../lib/time.ts");
  await setClock(zonedDate(2026, 10, 10, 9, 0, "America/New_York"));
}
