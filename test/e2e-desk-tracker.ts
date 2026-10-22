/**
 * End-to-end (offline model, live Binance data):
 *   mock desk run (no Discord post) → setups registered in bundled tracker
 *   → outcome check on live prices → forced price path: entry → TP1 → TP2
 *   → desk re-run sees the open book (keep/cancel) → cancel endpoint.
 * Uses an in-memory tracker DB and a temp cache dir. No secrets needed.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.XAI_MOCK = '1';
process.env.TRACKER_DB = 'memory';
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-e2e-'));
process.env.TRACKER_API_KEY = 'e2e-local-key';
for (const k of ['DISCORD_WEBHOOK_URL', 'DISCORD_WEBHOOK_URL_BTC', 'DISCORD_WEBHOOK_URL_XRP', 'TRACKER_URL', 'DATABASE_URL']) delete process.env[k];

const { startEphemeralTracker } = await import('../src/tracker/service.js');
const { JsonFileCache } = await import('../src/cache/index.js');
const { runDesk } = await import('../src/desk.js');

const symbol = process.argv[2] || 'XRPUSDT';
const tracker = await startEphemeralTracker();
process.env.TRACKER_URL = tracker.url;
const H = { 'Content-Type': 'application/json', 'X-Tracker-Key': 'e2e-local-key' };
const cache = new JsonFileCache(process.env.DATA_DIR!);

try {
  // 1. desk run → register
  const run1 = await runDesk({ cache, symbols: symbol, noPost: true });
  const r1 = run1.results[0];
  assert.ok(r1.success, `desk run failed: ${r1.error}`);
  assert.equal(r1.posted, false);
  console.log(`✔ desk run ok: ${r1.tradeCount} setup(s), tracker registered=${r1.tracker?.registered}`);
  assert.ok((r1.tracker?.registered ?? 0) >= 1, 'expected setups to be registered in the tracker');

  // auth enforced
  const unauth = await fetch(`${tracker.url}/api/trades`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauth.status, 401);
  console.log('✔ X-Tracker-Key enforced');

  const book = await (await fetch(`${tracker.url}/api/trades?active=1&symbol=${symbol}`)).json();
  assert.ok(book.trades.length >= 1);
  const t = book.trades[0];
  console.log(`✔ open book: ${book.trades.length} · ${t.direction} entry ${t.entry} stop ${t.current_stop ?? t.original_stop} status ${t.status}`);

  // 2. outcome check on live Binance prices
  const tick = await (await fetch(`${tracker.url}/api/tick`, { method: 'POST', headers: H, body: '{}' })).json();
  console.log(`✔ live outcome pass: checked=${tick.checked} events=${tick.events}`);
  assert.ok(tick.checked >= 1);

  // 3. forced price path through the engine
  const entry = Number(t.entry);
  const targets = (t.targets || []).map(Number);
  const path_ = [
    Number(t.entry_confirm_level ?? entry) * (t.direction === 'LONG' ? 0.999 : 1.001), // touch zone
    Number(t.entry_confirm_level ?? entry) * (t.direction === 'LONG' ? 1.001 : 0.999), // reclaim → open
    targets[0],
    targets[1] ?? targets[0],
    targets[1] ?? targets[0], // one engine event per tick, so repeat
    targets[1] ?? targets[0],
  ];
  console.log("  price path:", path_.join(", "), "targets:", JSON.stringify(t.targets));
  const seen: string[] = [];
  for (const px of path_) {
    const r = await (await fetch(`${tracker.url}/api/trades/${t.id}/process`, { method: 'POST', headers: H, body: JSON.stringify({ price: px }) })).json();
    seen.push(...(r.events || []).map((e: any) => e.type));
    if (r.trade?.status === 'closed' || r.trade?.closed_at) break;
  }
  const final = (await (await fetch(`${tracker.url}/api/trades?symbol=${symbol}&limit=50`)).json()).trades.find((x: any) => x.id === t.id);
  console.log(`✔ forced path events: ${seen.join(' → ')} · final status=${final.status} outcome=${final.outcome} R=${final.realized_r}`);
  assert.ok(seen.includes('entry_hit') && seen.includes('tp1_hit'), 'expected entry + TP1');
  assert.ok(seen.includes('tp2_hit'), 'expected TP2 close');

  const perf = await (await fetch(`${tracker.url}/api/performance`)).json();
  console.log(`✔ performance: trades=${perf.allTime?.totalTrades ?? perf.allTime?.trades} winRate=${perf.allTime?.winRate}`);

  // 4. desk re-run reviews the open book (if any remain open)
  const run2 = await runDesk({ cache, symbols: symbol, noPost: true });
  console.log(`✔ second desk run: openBook=${run2.results[0].openBook} reviews=${run2.results[0].openTradeReviews?.length}`);

  // 5. cancel endpoint
  const open = (await (await fetch(`${tracker.url}/api/trades?active=1&symbol=${symbol}`)).json()).trades;
  if (open.length) {
    const c = await (await fetch(`${tracker.url}/api/trades/cancel`, { method: 'POST', headers: H, body: JSON.stringify({ ids: [open[0].id], reason: 'e2e cancel' }) })).json();
    assert.equal(c.cancelled, 1);
    console.log('✔ cancel endpoint');
  }
  console.log('\nE2E PASS');
} finally {
  await tracker.close();
}
