import { randomUUID } from 'node:crypto';
import type { DeskCache, DeskRunRecord } from './cache/index.js';
import { runDesk } from './desk.js';

/** Run the desk and record the run (for the dashboard / history). */
export async function runAndRecord(
  cache: DeskCache,
  symbols: string | string[] | null,
  opts: { dryRun?: boolean; noPost?: boolean; trigger: DeskRunRecord['trigger'] },
) {
  let result: any;
  try {
    result = await runDesk({ cache, symbols, dryRun: opts.dryRun, noPost: opts.noPost });
  } catch (err: any) {
    result = { success: false, symbols: [symbols].flat(), error: err?.message || String(err), results: [] };
  }
  try {
    await cache.addRun({ id: randomUUID(), trigger: opts.trigger, dryRun: Boolean(opts.dryRun), result });
  } catch (e: any) {
    console.warn('Could not record run:', e?.message);
  }
  return result;
}
