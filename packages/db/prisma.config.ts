import path from "path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";

// Load workspace-level env (apps/web/.env) so CLI commands have DATABASE_URL.
const webEnvPath = path.resolve(__dirname, "../../apps/web/.env");
loadEnv({ path: webEnvPath });

function resolveUrl(): string {
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error(
      `DATABASE_URL not set. Looked for env file at ${webEnvPath}`,
    );
  }
  if (!raw.startsWith("file:")) return raw;
  const filePath = raw.slice("file:".length);
  if (path.isAbsolute(filePath)) return raw;
  // Resolve relative SQLite paths against apps/web (where Next.js runs).
  const abs = path.resolve(__dirname, "../../apps/web", filePath);
  return "file:" + abs;
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: resolveUrl(),
  },
});
