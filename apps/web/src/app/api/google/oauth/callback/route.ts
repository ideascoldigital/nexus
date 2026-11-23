import { NextRequest } from "next/server";
import { connectGoogleAccount, consumeGoogleState } from "@/services/google";

export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A small page in the user's browser: the app itself notices the new account. */
function page(title: string, detail: string, ok: boolean) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#18181b}
@media (prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}}main{max-width:420px;padding:24px;text-align:center}
h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.7}.i{font-size:32px;margin-bottom:12px}</style></head>
<body><main><div class="i">${ok ? "✓" : "!"}</div><h1>${esc(title)}</h1><p>${esc(detail)}</p></main></body></html>`;
  return new Response(html, { status: ok ? 200 : 400, headers: { "content-type": "text/html; charset=utf-8" } });
}

/** Google redirects here with ?code=&state= (or ?error=). */
export async function GET(req: NextRequest) {
  const state = req.nextUrl.searchParams.get("state");
  const code = req.nextUrl.searchParams.get("code");
  if (!state) return page("Something went wrong", "The sign-in came back without its state. Start again from Nexus.", false);
  try {
    const { verifier, redirectUri } = await consumeGoogleState(state);
    if (!code) return page("Not connected", "You cancelled on Google's screen. You can close this tab.", false);
    const email = await connectGoogleAccount(code, verifier, redirectUri);
    return page("Gmail connected", `${email} is connected to Nexus. You can close this tab and go back to the app.`, true);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[google] oauth callback failed:", message);
    return page("Not connected", message, false);
  }
}
