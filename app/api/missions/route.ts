import { getMissions, saveMission, deleteMission } from '@/lib/missionStore.server';
import type { Mission } from '@/lib/missionPlanner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const missions = await getMissions();
  return Response.json(missions);
}

export async function POST(req: Request) {
  let body: Mission;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.id || !body.type || !body.name || !body.target) {
    return Response.json({ error: 'Missing required fields: id, type, name, target' }, { status: 400 });
  }

  const missions = await saveMission(body);
  return Response.json(missions);
}

export async function PATCH(req: Request) {
  let body: Partial<Mission> & { id: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  if (!body.id) {
    return Response.json({ error: 'Missing required field: id' }, { status: 400 });
  }

  const all = await getMissions();
  const existing = all.find((m) => m.id === body.id);
  if (!existing) {
    return Response.json({ error: 'Mission not found' }, { status: 404 });
  }

  const updated: Mission = { ...existing, ...body, updatedAt: Date.now() };
  const missions = await saveMission(updated);
  return Response.json(missions);
}

export async function DELETE(req: Request) {
  const { searchParams } = new URL(req.url);
  const id = searchParams.get('id');
  if (!id) {
    return Response.json({ error: 'Missing query param: id' }, { status: 400 });
  }

  const missions = await deleteMission(id);
  return Response.json(missions);
}
