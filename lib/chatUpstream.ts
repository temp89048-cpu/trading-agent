// Pulled out of app/api/chat/route.ts into pure, testable functions.
// The bug this fixes: a custom/self-hosted OpenAI-compatible endpoint
// (LM Studio, Ollama, vLLM, text-generation-webui, LiteLLM, etc.) is
// very commonly entered without the trailing /v1 — e.g.
// "http://localhost:1234" instead of "http://localhost:1234/v1". The
// app was blindly appending "/chat/completions" to whatever baseUrl was
// given, so that mistake produced a request to
// "http://localhost:1234/chat/completions", which most of those servers
// 404 on with Go's default net/http handler text: "404 page not found".
// The app then surfaced that as an opaque "Upstream error 404: 404 page
// not found" with no indication of what to actually fix.

export function buildChatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}/chat/completions`;
}

// True only for the specific signature of "wrong path on an
// OpenAI-compatible local server", not for a 404 that's a legitimate
// upstream response (e.g. "model not found" would come back with a
// JSON body and often a different status).
export function looksLikeMissingV1(status: number, rawText: string, urlTried: string): boolean {
  if (status !== 404) return false;
  if (!/page not found/i.test(rawText.trim())) return false;
  return !/\/v1\//.test(urlTried) && !urlTried.includes('/v1/chat/completions');
}

// If the given base URL doesn't already carry a /v1 segment, return the
// same URL with one inserted before /chat/completions — the fallback to
// retry once before giving up. Returns null if there's nothing sensible
// to try (the URL already has /v1, so a second attempt would be
// identical and pointless).
export function withV1Inserted(baseUrl: string): string | null {
  const trimmed = baseUrl.replace(/\/$/, '');
  if (/\/v1$/.test(trimmed)) return null; // already ends in /v1 — the 404 isn't about this
  return `${trimmed}/v1`;
}

// Turns a raw upstream error body into the most useful message we can
// give: parse JSON error shapes most OpenAI-compatible servers use,
// fall back to a specific explanation for the missing-/v1 signature,
// otherwise the raw text (truncated).
export function parseUpstreamErrorMessage(status: number, rawText: string, urlTried: string, retriedUrl?: string): string {
  const trimmed = rawText.trim();

  // Most OpenAI-compatible servers return { "error": { "message": "..." } }
  // or { "error": "..." } on failure — surface that directly instead of
  // the raw JSON blob.
  try {
    const parsed = JSON.parse(trimmed);
    const msg = typeof parsed?.error === 'string' ? parsed.error : parsed?.error?.message;
    if (typeof msg === 'string' && msg.length > 0) {
      return retriedUrl ? `${msg} (tried ${urlTried}, then ${retriedUrl})` : msg;
    }
  } catch {
    // not JSON — fall through
  }

  if (looksLikeMissingV1(status, trimmed, urlTried)) {
    return (
      `Upstream error 404 at ${urlTried}: this looks like the base URL is missing "/v1" — ` +
      `common for self-hosted OpenAI-compatible servers (Ollama, LM Studio, vLLM, text-generation-webui, LiteLLM). ` +
      `Try setting the base URL to "${withV1Inserted(urlTried.replace(/\/chat\/completions$/, '')) ?? `${urlTried.replace(/\/chat\/completions$/, '')}/v1`}" instead.`
    );
  }

  return `Upstream error ${status}: ${trimmed.slice(0, 500)}`;
}
