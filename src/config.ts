// All configuration comes from the environment (Bun loads .env automatically).

const env = (key: string): string | undefined => {
  const v = process.env[key]?.trim();
  return v && !/^_+$/.test(v) ? v : undefined;
};

const list = (key: string): string[] =>
  (env(key) ?? "")
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean);

export const config = {
  port: Number(env("PORT") ?? 3000),
  databaseUrl: env("DATABASE_URL") ?? "postgres://localhost:5432/foodie",
  publicBaseUrl: (env("PUBLIC_BASE_URL") ?? `http://localhost:${env("PORT") ?? 3000}`).replace(/\/$/, ""),
  timezone: env("TIMEZONE") ?? "America/New_York",

  photon: {
    projectId: env("PHOTON_PROJECT_ID"),
    projectSecret: env("PHOTON_PROJECT_SECRET"),
    /** The number or link users text, from the Photon dashboard. */
    foodieLink: env("FOODIE_LINK"),
  },
  gemini: { apiKey: env("GEMINI_API_KEY"), model: env("GEMINI_MODEL") ?? "gemini-flash-latest" },
  google: {
    clientId: env("GOOGLE_OAUTH_CLIENT_ID"),
    clientSecret: env("GOOGLE_OAUTH_CLIENT_SECRET"),
    mapsKey: env("GOOGLE_MAPS_API_KEY"),
  },
  nessie: { apiKey: env("NESSIE_API_KEY"), baseUrl: env("NESSIE_BASE_URL") ?? "http://api.nessieisreal.com" },

  /** Key for encrypting Google tokens at rest. */
  encryptionKey: env("ENCRYPTION_KEY"),

  demo: env("DEMO") === "1",
  demoToken: env("DEMO_TOKEN"),
  /** Calendar date the demo clock runs on (the 10th of a 31-day month, as the budget numbers assume). */
  demoDate: env("DEMO_DATE") ?? "2026-10-10",
  demoArea: env("DEMO_AREA") ?? "Chapel Hill, NC",
  demoNames: {
    organizer: env("DEMO_ORGANIZER") ?? "Ronald",
    member: env("DEMO_MEMBER") ?? "Clive",
    newcomer: env("DEMO_NEWCOMER") ?? "Eric",
  },
  demoPhones: list("DEMO_PHONES"),
  demoGoogleAccounts: list("DEMO_GOOGLE_ACCOUNTS"),

  groupChatMode: env("GROUP_CHAT_MODE") === "1",
  /** Run the Spectrum terminal provider alongside iMessage. */
  terminal: env("TERMINAL") === "1",
  /** Use Gemini for intent parsing (otherwise the deterministic rules parser only). */
  useGemini: env("USE_GEMINI") !== "0",
};

export type Config = typeof config;

export const hasPhoton = () => Boolean(config.photon.projectId && config.photon.projectSecret);
export const hasGemini = () => Boolean(config.gemini.apiKey) && config.useGemini;
export const hasGoogleOAuth = () => Boolean(config.google.clientId && config.google.clientSecret);
export const hasMaps = () => Boolean(config.google.mapsKey);
export const hasNessie = () => Boolean(config.nessie.apiKey);
