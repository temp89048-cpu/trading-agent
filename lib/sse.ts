// Reads an OpenAI-compatible SSE stream (the format /api/chat forwards
// through unchanged) and calls onDelta with each new text chunk. Returns
// the last finish_reason seen (e.g. 'length' if the model hit the
// max_tokens cap, 'stop' for a normal completion), so the caller can
// flag a truncated reply.
export async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<{ finishReason: string | null }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finishReason: string | null = null;

  while (true) {
    if (signal?.aborted) {
      await reader.cancel().catch(() => {});
      return { finishReason };
    }
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (data === '[DONE]') return { finishReason };
      try {
        const json = JSON.parse(data);
        const delta: string | undefined = json?.choices?.[0]?.delta?.content;
        const fr: string | undefined = json?.choices?.[0]?.finish_reason;
        if (delta) onDelta(delta);
        if (fr) finishReason = fr;
      } catch {
        // partial/non-JSON line (some providers send comments) — skip it
      }
    }
  }
  return { finishReason };
}
