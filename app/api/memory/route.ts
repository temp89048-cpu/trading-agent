import { getStoredRiskPreference, setStoredRiskPreference } from '@/lib/memoryStore.server';

// Node runtime, not edge — this route uses the filesystem (see
// lib/memoryStore.server.ts for the same ephemeral-on-Vercel caveat as
// /api/trades). Trade stats themselves aren't served from here — the
// client already holds tradeLog from /api/trades and derives win rate /
// favorites / active-hours live via lib/memoryStats.ts. This route only
// persists the one thing that can't be derived: the explicitly stated
// risk preference.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const prefs = await getStoredRiskPreference();
  return Response.json(prefs);
}

export async function POST(req: Request) {
  let body: { riskPreference?: string | null };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { riskPreference } = body;
  if (riskPreference !== null && riskPreference !== 'conservative' && riskPreference !== 'moderate' && riskPreference !== 'aggressive') {
    return Response.json({ error: "riskPreference must be 'conservative', 'moderate', 'aggressive', or null" }, { status: 400 });
  }

  const next = await setStoredRiskPreference(riskPreference);
  return Response.json(next);
}
