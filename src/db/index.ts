import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { config } from "../config.ts";
import * as schema from "./schema.ts";

const client = postgres(config.databaseUrl, { max: 10, onnotice: () => {} });
export const db = drizzle(client, { schema });
export { schema };

export async function runMigrations(): Promise<void> {
  await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });
}

export async function closeDb(): Promise<void> {
  await client.end({ timeout: 5 });
}
