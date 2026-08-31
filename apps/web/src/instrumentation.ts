// Next.js server-startup hook. Runs once when the server boots — in every prod
// target (Tauri desktop sidecar, Docker container, plain `next start`) as well
// as `next dev`. We use it to co-start the terminal WebSocket server (node-pty)
// so it no longer needs a separate process that only ran under `pnpm dev`.
//
// This file is compiled for the edge runtime as well, so it must stay free of
// anything edge cannot resolve. The work itself lives in `instrumentation-node`
// behind the guarded dynamic import below — see that file for why the shape
// matters.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { registerNode } = await import("./instrumentation-node");
    await registerNode();
  }
}
