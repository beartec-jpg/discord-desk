import fs from 'node:fs';
import path from 'node:path';

/** One cached "general" multi-TF analysis per (symbol, pair interval). */
export interface GeneralCacheRow {
  aiNarration: any;
  snapshots: any[];
  higherTimeframe?: string;
  lowerTimeframe?: string;
  updatedAt?: string;
}

export interface DeskRunRecord {
  id: string;
  trigger: 'schedule' | 'cli' | 'dashboard';
  dryRun: boolean;
  result: any;
}

export interface DeskCache {
  kind: string;
  getGeneral(symbol: string, interval: string): Promise<GeneralCacheRow | null>;
  setGeneral(symbol: string, interval: string, row: GeneralCacheRow): Promise<void>;
  addRun(run: DeskRunRecord): Promise<void>;
  listRuns(limit?: number): Promise<DeskRunRecord[]>;
  close?(): Promise<void>;
}

/** Default: a single JSON file under DATA_DIR. Fine for a single process. */
export class JsonFileCache implements DeskCache {
  kind = 'json';
  private file: string;
  private maxRuns: number;
  constructor(dir: string, maxRuns = Number(process.env.DESK_MAX_RUNS || 50)) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'desk-cache.json');
    this.maxRuns = maxRuns;
  }
  private read(): { general: Record<string, GeneralCacheRow>; runs: DeskRunRecord[] } {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch {
      return { general: {}, runs: [] };
    }
  }
  private write(data: any) {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
  }
  async getGeneral(symbol: string, interval: string) {
    return this.read().general[`${symbol}|${interval}`] || null;
  }
  async setGeneral(symbol: string, interval: string, row: GeneralCacheRow) {
    const d = this.read();
    d.general[`${symbol}|${interval}`] = row;
    this.write(d);
  }
  async addRun(run: DeskRunRecord) {
    const d = this.read();
    d.runs = [run, ...(d.runs || [])].slice(0, this.maxRuns);
    this.write(d);
  }
  async listRuns(limit = 20) {
    return (this.read().runs || []).slice(0, limit);
  }
}

/** Optional: Postgres when DATABASE_URL is set (tables auto-created). */
export class PostgresCache implements DeskCache {
  kind = 'postgres';
  private pool: any;
  private ready: Promise<void>;
  constructor(url: string) {
    this.ready = (async () => {
      const pg = await import('pg');
      const Pool = (pg as any).default?.Pool || (pg as any).Pool;
      this.pool = new Pool({
        connectionString: url,
        ssl: url.includes('sslmode=require') || process.env.DB_SSL === '1' ? { rejectUnauthorized: false } : undefined,
        max: 3,
      });
      await this.pool.query(`CREATE TABLE IF NOT EXISTS desk_general_cache (
        symbol text NOT NULL, interval text NOT NULL, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (symbol, interval))`);
      await this.pool.query(`CREATE TABLE IF NOT EXISTS desk_runs (
        id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL)`);
    })();
  }
  async getGeneral(symbol: string, interval: string) {
    await this.ready;
    const r = await this.pool.query('SELECT data FROM desk_general_cache WHERE symbol=$1 AND interval=$2', [symbol, interval]);
    return r.rows[0]?.data || null;
  }
  async setGeneral(symbol: string, interval: string, row: GeneralCacheRow) {
    await this.ready;
    await this.pool.query(
      `INSERT INTO desk_general_cache (symbol, interval, data) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (symbol, interval) DO UPDATE SET data=EXCLUDED.data, updated_at=now()`,
      [symbol, interval, JSON.stringify(row)],
    );
  }
  async addRun(run: DeskRunRecord) {
    await this.ready;
    await this.pool.query('INSERT INTO desk_runs (id, data) VALUES ($1,$2::jsonb) ON CONFLICT DO NOTHING', [run.id, JSON.stringify(run)]);
  }
  async listRuns(limit = 20) {
    await this.ready;
    const r = await this.pool.query('SELECT data FROM desk_runs ORDER BY created_at DESC LIMIT $1', [limit]);
    return r.rows.map((x: any) => x.data);
  }
  async close() {
    await this.ready.catch(() => {});
    await this.pool?.end();
  }
}

export function createCache(): DeskCache {
  const url = (process.env.DATABASE_URL || '').trim();
  if (url && (process.env.DESK_CACHE || 'auto') !== 'json') return new PostgresCache(url);
  return new JsonFileCache(process.env.DATA_DIR || './data');
}
