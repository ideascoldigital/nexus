import { strict as assert } from "node:assert";
import { after, before, test } from "node:test";
import { spawn, type ChildProcess } from "child_process";
import http from "http";
import net from "net";
import path from "path";
import { WebSocket } from "ws";

// The sidecar starts listening on import (fixed port 3001), so it runs as a
// child process instead of being imported into the test.
const PORT = 3001;

let child: ChildProcess | undefined;
let portBusy = false;

function isPortBusy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net
      .createServer()
      .once("error", () => resolve(true))
      .once("listening", () => srv.close(() => resolve(false)))
      .listen(port, "127.0.0.1");
  });
}

function get(urlPath: string): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "localhost", port: PORT, path: urlPath }, (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        );
      })
      .on("error", reject);
  });
}

before(async () => {
  portBusy = await isPortBusy(PORT);
  if (portBusy) return;

  // Run tsx as a node loader rather than through `node_modules/.bin/tsx`: that
  // path is a shell script with no extension, which Windows cannot exec, and
  // its `.cmd` sibling is refused by Node with EINVAL unless `shell: true` —
  // which would cost us the stdout pipe this hook reads "listening" from.
  child = spawn(process.execPath, ["--import", "tsx", "src/sidecar-server.ts"], {
    cwd: path.resolve(__dirname, ".."),
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("sidecar did not start in time")),
      10_000,
    );
    child!.stdout!.on("data", (d: Buffer) => {
      if (d.toString().includes("listening")) {
        clearTimeout(timeout);
        resolve();
      }
    });
    child!.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`sidecar exited early with code ${code}`));
    });
  });
});

after(() => {
  child?.kill("SIGTERM");
});

test("GET /health reports local-first mode", async (t) => {
  if (portBusy) return t.skip("port 3001 already in use");
  const res = await get("/health");
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), {
    status: "ok",
    mode: "local-first",
    phase: "0",
  });
  assert.equal(res.headers["access-control-allow-origin"], "http://localhost:3000");
});

test("unknown routes return 404 JSON", async (t) => {
  if (portBusy) return t.skip("port 3001 already in use");
  const res = await get("/nope");
  assert.equal(res.status, 404);
  assert.match(JSON.parse(res.body).error, /Not found/);
});

test("websocket connections are refused with 1001", async (t) => {
  if (portBusy) return t.skip("port 3001 already in use");
  const ws = new WebSocket(`ws://localhost:${PORT}`);
  const code = await new Promise<number>((resolve, reject) => {
    ws.on("close", (c) => resolve(c));
    ws.on("error", reject);
  });
  assert.equal(code, 1001);
});
