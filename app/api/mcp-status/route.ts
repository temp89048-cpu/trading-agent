// Scope note (read this before assuming more than it does): this route
// only checks whether an MCP server URL is reachable over HTTP. It does
// NOT implement the MCP JSON-RPC handshake (initialize/tools-list) and
// does NOT wire any tool-calling into the chat loop — that's a separate,
// much larger piece of work than a status check. See the MCP Manager UI
// copy for the same disclosure to the person using the app.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: { url?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = body.url?.trim();
  if (!url) return Response.json({ error: 'Missing url' }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return Response.json({ reachable: false, error: 'Not a valid URL' });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return Response.json({ reachable: false, error: 'Only http(s) URLs are supported' });
  }

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(4000),
      headers: { 'User-Agent': 'Mozilla/5.0 (QUANT-terminal MCP status check)' },
    });
    return Response.json({ reachable: true, status: res.status, latencyMs: Date.now() - started });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unreachable';
    return Response.json({ reachable: false, error: message, latencyMs: Date.now() - started });
  }
}
