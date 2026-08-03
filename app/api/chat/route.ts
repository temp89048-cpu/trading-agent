// Replaces server.js. Same job: the browser can't call most providers'
// /chat/completions directly (no CORS headers on their side), so this
// route re-issues the request server-to-server and streams the raw SSE
// body straight back. Nothing is logged or persisted — the API key
// passes through in memory for the duration of this one request.
//
// Deployed on Vercel this just works with no local process to keep
// running, unlike server.js.

import { buildChatCompletionsUrl, looksLikeMissingV1, withV1Inserted, parseUpstreamErrorMessage } from '@/lib/chatUpstream';

// Edge runtime, not Node — belt-and-suspenders for streaming reliability.
// Locally (self-hosted `next start`/`next dev`), we verified this route
// already forwards SSE chunks the instant they arrive under the Node
// runtime too (see STREAMING_TEST_RESULT.txt). But Vercel's Node.js
// Serverless Functions are documented to buffer a function's full
// response before returning it, unlike Edge Functions — so if this ever
// gets deployed to Vercel, Edge is the runtime that's actually guaranteed
// to stream token-by-token to the browser instead of arriving all at once.
export const runtime = 'edge';

type ChatBody = {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  messages: { role: string; content: string }[];
  temperature?: number;
  maxTokens?: number;
};

async function callUpstream(url: string, apiKey: string, payload: Record<string, unknown>): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(payload),
  });
}

export async function POST(req: Request) {
  let body: ChatBody;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { apiKey, baseUrl, model, messages, temperature, maxTokens } = body;

  if (!apiKey) {
    return Response.json({ error: 'Missing API key' }, { status: 400 });
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'Missing messages' }, { status: 400 });
  }

  const resolvedBaseUrl = baseUrl || 'https://integrate.api.nvidia.com/v1';
  const upstreamUrl = buildChatCompletionsUrl(resolvedBaseUrl);
  const payload = {
    model: model || 'z-ai/glm-5.2',
    messages,
    temperature: temperature ?? 0.2,
    top_p: 1,
    max_tokens: maxTokens ?? 1536,
    stream: true,
  };

  let upstreamRes: Response;
  try {
    upstreamRes = await callUpstream(upstreamUrl, apiKey, payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown error';
    return Response.json({ error: `Could not reach ${upstreamUrl}: ${message}` }, { status: 502 });
  }

  // Self-hosted OpenAI-compatible servers (Ollama, LM Studio, vLLM,
  // text-generation-webui, LiteLLM) are very commonly pointed at without
  // the trailing /v1. Rather than fail outright on that one-character
  // mistake, detect the specific 404 signature and retry once against
  // the corrected URL before giving up.
  let retriedUrl: string | undefined;
  if (!upstreamRes.ok) {
    const text = await upstreamRes.clone().text().catch(() => '');
    if (looksLikeMissingV1(upstreamRes.status, text, upstreamUrl)) {
      const fixedBase = withV1Inserted(resolvedBaseUrl);
      if (fixedBase) {
        retriedUrl = buildChatCompletionsUrl(fixedBase);
        try {
          upstreamRes = await callUpstream(retriedUrl, apiKey, payload);
        } catch {
          // retry failed to even connect — fall through and report the original error
        }
      }
    }
  }

  if (!upstreamRes.ok || !upstreamRes.body) {
    const text = await upstreamRes.text().catch(() => '');
    return Response.json(
      { error: parseUpstreamErrorMessage(upstreamRes.status, text, upstreamUrl, retriedUrl) },
      { status: upstreamRes.status || 502 },
    );
  }

  return new Response(upstreamRes.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tells nginx-style proxies not to buffer this response
    },
  });
}
