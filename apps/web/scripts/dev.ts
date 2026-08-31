import { execSync } from "child_process";

// Start both Next.js dev server and the sidecar WebSocket server concurrently.
// Next.js runs on port 3000 (with Turbopack) and the sidecar runs on port 3001.

try {
  execSync(
    'npx concurrently --names "next,sidecar" --prefix-colors "cyan,yellow" "npm run dev:next" "npm run dev:server"',
    {
      stdio: "inherit",
      cwd: new URL("..", import.meta.url).pathname,
    }
  );
} catch {
  process.exit(1);
}
