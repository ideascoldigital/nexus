import path from "path";
import type { NextConfig } from "next";

const isStandalone = process.env.NEXUX_BUILD_TARGET === "native";
const workspaceRoot = path.resolve(__dirname, "../..");

const nextConfig: NextConfig = {
  output: isStandalone ? "standalone" : undefined,
  outputFileTracingRoot: isStandalone ? workspaceRoot : undefined,
  outputFileTracingIncludes: isStandalone
    ? {
        "*": [
          "../../node_modules/.pnpm/better-sqlite3@*/node_modules/better-sqlite3/**",
          "../../node_modules/.pnpm/@prisma+adapter-better-sqlite3@*/node_modules/@prisma/adapter-better-sqlite3/**",
          "../../node_modules/.pnpm/@prisma+client@*/node_modules/@prisma/client/**",
          "../../node_modules/.pnpm/@lancedb+lancedb@*/node_modules/@lancedb/lancedb/**",
          "../../node_modules/.pnpm/@lancedb+lancedb-darwin-arm64@*/node_modules/@lancedb/lancedb-darwin-arm64/**",
          "../../node_modules/.pnpm/@lancedb+lancedb-darwin-x64@*/node_modules/@lancedb/lancedb-darwin-x64/**",
          "../../node_modules/.pnpm/@lancedb+lancedb-linux-x64-gnu@*/node_modules/@lancedb/lancedb-linux-x64-gnu/**",
          "../../node_modules/.pnpm/@lancedb+lancedb-win32-x64-msvc@*/node_modules/@lancedb/lancedb-win32-x64-msvc/**",
          "../../node_modules/.pnpm/ollama@*/node_modules/ollama/**",
          "../../node_modules/.pnpm/node-pty@*/node_modules/node-pty/**",
          "../../node_modules/.pnpm/ws@*/node_modules/ws/**",
          "../../packages/db/src/generated/**",
        ],
      }
    : undefined,
  serverExternalPackages: [
    "@lancedb/lancedb",
    "ollama",
    "better-sqlite3",
    "@prisma/adapter-better-sqlite3",
    "@prisma/client",
    "node-pty",
    // Bundling ws turns its optional `require('bufferutil')` into a webpack
    // stub that resolves to {} instead of throwing — ws then routes every
    // masked frame ≥32 bytes through `{}.unmask` and the terminal dies with
    // an uncaughtException on the first paste. External, the require really
    // throws and ws keeps its pure-JS fallback.
    "ws",
  ],
  webpack: (config, { isServer }) => {
    if (isServer) {
      config.externals = config.externals || [];
      config.externals.push({
        "@lancedb/lancedb": "commonjs @lancedb/lancedb",
        "better-sqlite3": "commonjs better-sqlite3",
        "bindings": "commonjs bindings",
        "@prisma/adapter-better-sqlite3":
          "commonjs @prisma/adapter-better-sqlite3",
        "@prisma/client": "commonjs @prisma/client",
        ollama: "commonjs ollama",
        "node-pty": "commonjs node-pty",
        // Same reason as serverExternalPackages above — instrumentation.ts
        // boots the terminal server through this webpack pass too.
        ws: "commonjs ws",
      });
    }
    return config;
  },
};

export default nextConfig;
