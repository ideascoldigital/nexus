// Imported by workspace-routes.test.ts BEFORE any route module.
//
// These routes resolve the active workspace from a cookie, and Next's
// `cookies()` throws outside a request scope — which is where a unit test
// calls a handler from. NEXUX_TEST_WORKSPACE makes getActiveWorkspaceId skip
// the cookie read; setting it here means it is in place before the route
// modules load.
//
// Re-exports the shared DB setup so the import order stays a single line in
// the test file. Not matched by the test glob (`*.test.ts`).
export { testDbDir } from "./routes.test-setup";

/** The workspace handlers see; tests reassign it to switch workspaces. */
export function setActiveWorkspace(id: string): void {
  process.env.NEXUX_TEST_WORKSPACE = id;
}

setActiveWorkspace("ws-default");
