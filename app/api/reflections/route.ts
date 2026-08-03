import { listReflections, getReflection, saveReflection } from '@/lib/reflectionStore.server';
import type { ReflectionRecord } from '@/lib/reflectionStore.server';

// Node runtime, not edge — filesystem-backed, same as /api/trades and
// /api/memory.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tradeId = searchParams.get('tradeId');
  if (tradeId) {
    const record = await getReflection(tradeId);
    return Response.json({ reflection: record });
  }
  const all = await listReflections();
  return Response.json({ reflections: all });
}

export async function POST(req: Request) {
  let body: Partial<ReflectionRecord>;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { tradeId, symbol, content, sections, entryContextUsed, exitContextUsed, finishReason } = body;
  if (!tradeId || typeof tradeId !== 'string') {
    return Response.json({ error: 'tradeId is required' }, { status: 400 });
  }
  if (!symbol || typeof symbol !== 'string') {
    return Response.json({ error: 'symbol is required' }, { status: 400 });
  }
  if (!content || typeof content !== 'string') {
    return Response.json({ error: 'content is required' }, { status: 400 });
  }
  if (typeof exitContextUsed !== 'string') {
    return Response.json({ error: 'exitContextUsed is required' }, { status: 400 });
  }

  const record: ReflectionRecord = {
    tradeId,
    ts: Date.now(),
    symbol,
    content,
    sections: sections && typeof sections === 'object' ? sections : null,
    entryContextUsed: typeof entryContextUsed === 'string' ? entryContextUsed : null,
    exitContextUsed,
    finishReason: typeof finishReason === 'string' ? finishReason : null,
  };

  const saved = await saveReflection(record);
  return Response.json({ reflection: saved }, { status: 201 });
}
