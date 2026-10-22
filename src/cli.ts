#!/usr/bin/env node
import { config, trackerMode } from './config.js';
import { createCache } from './cache/index.js';
import { runAndRecord } from './runner.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : '';
}
const has = (n: string) => process.argv.includes(`--${n}`);

if (has('help')) {
  console.log(`Usage: npm run desk -- [--symbol BTCUSDT|XRPUSDT|BTCUSDT,XRPUSDT] [--dry-run] [--mock] [--json]
  --symbol   symbol(s) to run (default DISCORD_DESK_SYMBOLS or BTCUSDT)
  --dry-run  build the Discord payload and print it; do not post or write to the tracker
  --mock     use the offline mock model (no xAI key needed)
  --no-post  don't post to Discord, but DO register/cancel setups in the tracker
  --no-tracker  skip the trade tracker for this run
  --check-outcomes  after the run, run one tracker outcome pass on live Binance prices
  --json     print the full result as JSON`);
  process.exit(0);
}
if (has('mock')) process.env.XAI_MOCK = '1';

const dryRun = has('dry-run');
const noPost = has('no-post');
const cache = createCache();

// Bundled tracker: if no TRACKER_URL, open the local tracker DB in-process for this run.
let tracker: { url: string; close(): Promise<void> } | null = null;
if (trackerMode() === 'bundled' && !has('no-tracker')) {
  try {
    const { startEphemeralTracker } = await import('./tracker/service.js');
    tracker = await startEphemeralTracker();
    process.env.TRACKER_URL = tracker.url;
  } catch (e: any) {
    console.warn(`⚠️  Bundled tracker unavailable, continuing without it: ${e?.message}`);
    delete process.env.TRACKER_URL;
  }
} else if (trackerMode() === 'off' || has('no-tracker')) {
  delete process.env.TRACKER_URL;
}

const result = await runAndRecord(cache, arg('symbol') || null, { dryRun, noPost, trigger: 'cli' });

if (tracker && has('check-outcomes')) {
  const r = await fetch(`${tracker.url}/api/tick`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.TRACKER_API_KEY ? { 'X-Tracker-Key': process.env.TRACKER_API_KEY } : {}) }, body: '{}' });
  console.log('📒 Outcome check:', await r.text());
}

if (has('json')) {
  console.log(JSON.stringify(result, null, 2));
} else {
  if (result.error) console.error('❌', result.error);
  for (const r of result.results || []) {
    console.log(`\n===== ${r.symbol}: ${r.success ? 'OK' : 'FAILED'}${r.dryRun ? ' (dry run — not posted)' : ''} =====`);
    if (r.error) console.log('Error:', r.error);
    if (r.payload && (dryRun || !r.success)) {
      console.log(r.payload.content);
      for (const e of r.payload.embeds || []) {
        console.log(`\n--- ${e.title || '(embed)'} ---`);
        if (e.description) console.log(e.description);
        for (const f of e.fields || []) console.log(`  [${f.name}] ${f.value}`);
        if (e.footer?.text) console.log(`  (${e.footer.text})`);
      }
    }
    console.log(`\nSetups: ${r.tradeCount ?? 0} · tokens ${JSON.stringify(r.tokens || {})} · est. cost $${(r.estimatedCost ?? 0).toFixed?.(4) ?? r.estimatedCost}`);
  }
}
void config;
await tracker?.close();
await cache.close?.();
process.exit(result.success ? 0 : 1);
