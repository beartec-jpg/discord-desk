import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal pg.Pool-compatible surface used by the tracker (query + end).
 * - DATABASE_URL set (and TRACKER_DB != local) → real Postgres via `pg`.
 * - otherwise → embedded Postgres (PGlite, WASM) stored under DATA_DIR/tracker-db,
 *   so the same schema.sql and SQL run unchanged with no server to install.
 *   TRACKER_DB=memory keeps it in memory (tests).
 */
export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount: number }>;
  end(): Promise<void>;
  kind: 'postgres' | 'pglite' | 'pglite-memory';
}

let pool: Queryable | null = null;

async function makePg(url: string): Promise<Queryable> {
  const pg = await import('pg');
  const Pool = (pg as any).default?.Pool || (pg as any).Pool;
  const needsSsl = process.env.DB_SSL === '1' || url.includes('sslmode=require');
  const p = new Pool({ connectionString: url, ssl: needsSsl ? { rejectUnauthorized: false } : undefined, max: 5 });
  return {
    kind: 'postgres',
    query: async (t, v) => {
      const r = await p.query(t, v);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    end: () => p.end(),
  };
}

async function makePglite(memory: boolean): Promise<Queryable> {
  const { PGlite, types } = await import('@electric-sql/pglite');
  let dataDir: string | undefined;
  if (!memory) {
    dataDir = path.resolve(process.env.DATA_DIR || './data', 'tracker-db');
    fs.mkdirSync(dataDir, { recursive: true });
  }
  // Match node-postgres: NUMERIC/INT8 come back as strings (tracker code Number()s them).
  const db = new PGlite(dataDir, {
    parsers: { [types.NUMERIC]: (v: string) => v, [types.INT8]: (v: string) => v },
  } as any);
  await db.waitReady;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };
  return {
    kind: memory ? 'pglite-memory' : 'pglite',
    query: (t, v) =>
      serial(async () => {
        if (!v || v.length === 0) {
          // allow multi-statement SQL (schema)
          const res = await db.exec(t);
          const last = res[res.length - 1];
          return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? last?.rows?.length ?? 0 };
        }
        const r = await db.query(t, v);
        return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
      }),
    end: () => db.close(),
  };
}

export async function initPool(): Promise<Queryable> {
  if (pool) return pool;
  const url = (process.env.DATABASE_URL || '').trim();
  const mode = (process.env.TRACKER_DB || 'auto').toLowerCase();
  if (url && mode !== 'local' && mode !== 'memory') pool = await makePg(url);
  else pool = await makePglite(mode === 'memory');
  return pool;
}

export function getPool(): Queryable {
  if (!pool) throw new Error('tracker DB not initialised — call initPool() first');
  return pool;
}

export async function migrate(): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'schema.sql'), path.resolve('src/tracker/schema.sql')];
  const sqlPath = candidates.find((p) => fs.existsSync(p));
  if (!sqlPath) throw new Error('schema.sql not found');
  await getPool().query(fs.readFileSync(sqlPath, 'utf8'));
  console.log(`[tracker] schema applied (${getPool().kind})`);
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
