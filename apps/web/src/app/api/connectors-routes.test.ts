import assert from "node:assert/strict";
import fs from "node:fs";
import { after, test } from "node:test";

// Env setup must stay above every other import (throwaway DB → ephemeral vault key).
import { testDbDir } from "./routes.test-setup";
import { NextRequest } from "next/server";
import { prisma } from "@nexux/db";

import { GET as list } from "./connectors/route";
import { DELETE as disconnect, PATCH as patch, PUT as put } from "./connectors/[id]/route";
import { connectorServersFor } from "@/services/connector-store";

after(async () => {
  await prisma.$disconnect();
  fs.rmSync(testDbDir, { recursive: true, force: true });
});

const req = (method: string, body?: unknown) =>
  new NextRequest("http://localhost/x", { method, body: body === undefined ? undefined : JSON.stringify(body) });
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Status = { id: string; connected: boolean; botIds: string[] | null; values: Record<string, string>; secretsSet: string[] };

test("connect an app: sealed at rest, never echoed, editable without retyping the token", async () => {
  const res = await put(req("PUT", { values: { uri: "mongodb+srv://ro:pw@c.x.net" } }), params("mongodb"));
  assert.equal(res.status, 200);

  const raw = await prisma.$queryRawUnsafe<{ config: string }[]>(`SELECT config FROM Connector WHERE id = 'mongodb'`);
  assert.ok(!String(raw[0]!.config).includes("ro:pw"), "config is sealed in the database");

  const body = await (await list()).text();
  assert.ok(!body.includes("ro:pw"));
  const mongo = (JSON.parse(body) as Status[]).find((s) => s.id === "mongodb")!;
  assert.equal(mongo.connected, true);
  assert.deepEqual(mongo.secretsSet, ["uri"]);
  assert.equal(mongo.values.readOnly, "true");

  await put(req("PUT", { values: { uri: "", readOnly: false } }), params("mongodb"));
  const servers = await connectorServersFor("any-bot");
  assert.deepEqual(servers.mongodb!.env, { MDB_MCP_CONNECTION_STRING: "mongodb+srv://ro:pw@c.x.net" });
  assert.deepEqual(servers.mongodb!.args, ["-y", "mongodb-mcp-server"]);
});

test("only the bots it is given to get it; bad input and unknown apps are refused", async () => {
  await put(req("PUT", { values: { token: "github_pat_abc" }, botIds: ["b1"] }), params("github"));
  assert.ok((await connectorServersFor("b1")).github);
  assert.equal((await connectorServersFor("b2")).github, undefined);
  assert.equal((await patch(req("PATCH", { botIds: null }), params("github"))).status, 200);
  assert.ok((await connectorServersFor("b2")).github);

  assert.equal((await put(req("PUT", { values: { token: "nope" } }), params("github"))).status, 400);
  assert.equal((await put(req("PUT", { values: {} }), params("nothing"))).status, 404);
  assert.equal((await put(req("PUT", { values: {} }), params("gmail"))).status, 404);

  assert.equal((await disconnect(req("DELETE"), params("github"))).status, 200);
  assert.equal((await connectorServersFor("b1")).github, undefined);
  assert.equal((await disconnect(req("DELETE"), params("github"))).status, 404);
});
