import http from "http";
import { WebSocketServer } from "ws";

const PORT = 3001;
const CORS_ORIGIN = "http://localhost:3000";

// Minimal server stub for local-first architecture (Fase 0)
// Will be extended in later phases for Tools, MCPs and interactive terminal support.

function setCorsHeaders(res: http.ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, PUT, DELETE, OPTIONS"
  );
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function sendJson(
  res: http.ServerResponse,
  statusCode: number,
  data: unknown
): void {
  setCorsHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);
  const pathname = url.pathname;
  const method = req.method?.toUpperCase();

  if (method === "OPTIONS") {
    setCorsHeaders(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // Health check
  if (method === "GET" && pathname === "/health") {
    sendJson(res, 200, { status: "ok", mode: "local-first", phase: "0" });
    return;
  }

  sendJson(res, 404, { error: "Not found - server in cleanup phase" });
}

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.close(1001, "Server in Fase 0 cleanup - no WebSocket support yet");
});

server.listen(PORT, () => {
  console.log(`[sidecar] Minimal server listening on port ${PORT} (Fase 0)`);
});

process.on("SIGTERM", () => {
  console.log("[sidecar] Shutting down...");
  server.close(() => process.exit(0));
});
