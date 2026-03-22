import { defineConfig } from "drizzle-kit";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("postgres")) {
  throw new Error(
    "Set DATABASE_URL to your Postgres URL before running drizzle-kit (e.g. Neon pooled string).",
  );
}

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
});
