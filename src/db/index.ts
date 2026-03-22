import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "DATABASE_URL is required (e.g. postgresql://user:pass@host/db?sslmode=require)",
    );
  }
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    throw new Error(
      "DATABASE_URL must be a Postgres connection string (postgres:// or postgresql://)",
    );
  }
  return url;
}

const globalForDb = globalThis as unknown as {
  __pool?: Pool;
  __drizzle?: ReturnType<typeof drizzle<typeof schema>>;
};

export function getDb() {
  if (!globalForDb.__pool) {
    globalForDb.__pool = new Pool({
      connectionString: requireDatabaseUrl(),
      max: 1,
      idleTimeoutMillis: 20_000,
      connectionTimeoutMillis: 10_000,
    });
    globalForDb.__drizzle = drizzle(globalForDb.__pool, { schema });
  }
  return globalForDb.__drizzle!;
}

export * from "./schema";
