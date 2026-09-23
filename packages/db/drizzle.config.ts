import type { Config } from "drizzle-kit";

export default {
  schema: "./src/schema/index.ts",
  out: "./migrations",
  dialect: "postgresql",
  // PGlite locally; a connection string in every other environment.
  dbCredentials: { url: process.env.DATABASE_URL ?? "file://./.data/cac.db" },
  strict: true,
  verbose: true,
} satisfies Config;
