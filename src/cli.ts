#!/usr/bin/env node
import { config } from './config.js';
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
  --mock     use the offline mock model (no xAI key needed); implies nothing else
  --json     print the full result as JSON`);
  process.exit(0);
}
if (has('mock')) process.env.XAI_MOCK = '1';

const dryRun = has('dry-run');
const cache = createCache();
const result = await runAndRecord(cache, arg('symbol') || null, { dryRun, trigger: 'cli' });

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
await cache.close?.();
process.exit(result.success ? 0 : 1);
