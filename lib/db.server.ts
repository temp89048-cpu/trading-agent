// ---------------------------------------------------------------------
// The Next.js side's Postgres connection. Server-only.
//
// WHY THIS EXISTS
//
// The app had three stores: Postgres (the Python agent), JSON files under
// `.data/` (the Next routes), and `localStorage` (the browser). One quantity
// could therefore have three different values, and the dashboard read whichever
// one its page happened to be wired to — `/orders` showed four browser trades
// while the agent had made 2,620. Consolidating on Postgres means every reader
// sees the same book, and data survives clearing site data or changing machine.
//
// `db/schema.sql` was already built for this: nearly every table carries a
// "Source: lib/xStore.server.ts" comment. The schema was designed for the
// migration and was simply never wired to this half of the app.
//
// ONE POOL PER PROCESS, AND WHY THE GLOBAL
//
// Next.js dev hot-reloads modules, so a module-level `new Pool()` leaks a pool
// per reload until Postgres refuses connections ("too many clients"). The pool is
// therefore stashed on `globalThis`, which survives reload. This is the standard
// Next + node-postgres arrangement, not a hack.
//
// DEGRADES HONESTLY. `getPool()` returns null when `DATABASE_URL` is unset rather
// than throwing at import time, so a checkout with no database still boots and
// each store reports "no database configured" instead of the app failing to
// start. What it must NOT do is silently return empty data as though the table
// were empty — callers distinguish the two.
// ---------------------------------------------------------------------

import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

declare global {
  // eslint-disable-next-line no-var
  var __tradingosPgPool: Pool | null | undefined;
}

/** Why the pool is unavailable, for a caller that wants to say so. */
export type DbUnavailable = { reason: string };

let warnedMissingUrl = false;

function connectionString(): string | null {
  const url = process.env.DATABASE_URL?.trim();
  return url ? url : null;
}

/**
 * TLS for hosted providers.
 *
 * Neon, Supabase, Railway, Render and most managed Postgres require TLS but
 * present certificates signed by a CA Node does not ship. `rejectUnauthorized:
 * false` is what their own connection snippets use.
 *
 * It is applied ONLY to non-local hosts. Turning certificate verification off
 * for every connection — including a production database on your own
 * infrastructure with a real certificate — would silently accept a
 * man-in-the-middle, so a local socket gets no TLS and a remote host gets TLS
 * with the provider's documented setting. Set `DATABASE_SSL=strict` to demand a
 * verifiable chain, or `DATABASE_SSL=off` to disable TLS entirely.
 */
function sslConfig(url: string): false | { rejectUnauthorized: boolean } {
  const mode = (process.env.DATABASE_SSL || '').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'strict') return { rejectUnauthorized: true };

  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // An unparseable URL is the pool's problem to report, not ours to guess at.
    return false;
  }
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '';
  return local ? false : { rejectUnauthorized: false };
}

/** The shared pool, or null when no `DATABASE_URL` is configured. */
export function getPool(): Pool | null {
  if (global.__tradingosPgPool !== undefined) return global.__tradingosPgPool;

  const url = connectionString();
  if (!url) {
    if (!warnedMissingUrl) {
      warnedMissingUrl = true;
      console.warn(
        '[db] DATABASE_URL is not set. Server stores will report "no database configured" ' +
          'rather than returning empty data — see lib/db.server.ts and SETUP-DATABASE.md.',
      );
    }
    global.__tradingosPgPool = null;
    return null;
  }

  const pool = new Pool({
    connectionString: url,
    ssl: sslConfig(url),
    // Small: a hosted Postgres free tier often caps total connections in the low
    // tens, and the Python backend holds up to 20 of them already.
    max: Number(process.env.DATABASE_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    // Fail a hung connect attempt rather than leaving a request pending forever.
    connectionTimeoutMillis: 10_000,
  });

  // An idle-client error (a dropped connection, a provider restarting) is emitted
  // on the pool. Without a listener it becomes an unhandled 'error' event and
  // takes the whole Node process down.
  pool.on('error', (err) => {
    console.error('[db] idle client error:', err.message);
  });

  global.__tradingosPgPool = pool;
  return pool;
}

/**
 * Run a query. Returns `null` when there is no database configured.
 *
 * `null` and "zero rows" are different answers and callers must not conflate
 * them: one means "we could not look", the other means "we looked and there is
 * nothing". Every store in this codebase reports which.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T> | null> {
  const pool = getPool();
  if (!pool) return null;
  return pool.query<T>(sql, params);
}

/** Rows only, or null when unavailable. */
export async function rows<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[] | null> {
  const result = await query<T>(sql, params);
  return result ? result.rows : null;
}

/** First row, `undefined` for an empty result, `null` when unavailable. */
export async function one<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T | undefined | null> {
  const result = await query<T>(sql, params);
  if (!result) return null;
  return result.rows[0];
}

/**
 * Run several statements as one transaction.
 *
 * Used where a write must be all-or-nothing — replacing a watchlist, or saving a
 * portfolio's cash and its positions together. A partial write there would leave
 * cash that does not match the positions it paid for.
 */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T | null> {
  const pool = getPool();
  if (!pool) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    // Roll back before releasing, or the client goes back to the pool mid
    // transaction and the NEXT caller inherits it.
    try {
      await client.query('ROLLBACK');
    } catch (rollbackErr) {
      console.error('[db] rollback failed:', (rollbackErr as Error).message);
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Connectivity probe for `/api/health` and the setup steps. */
export async function ping(): Promise<
  | { ok: true; serverVersion: string; tables: number }
  | { ok: false; reason: string }
> {
  const pool = getPool();
  if (!pool) {
    return { ok: false, reason: 'DATABASE_URL is not set' };
  }
  try {
    const version = await pool.query<{ server_version: string }>('SHOW server_version');
    const count = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    return {
      ok: true,
      serverVersion: version.rows[0]?.server_version ?? 'unknown',
      tables: Number(count.rows[0]?.n ?? 0),
    };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
