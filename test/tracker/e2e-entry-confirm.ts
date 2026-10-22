/**
 * Entry confirmation: reclaim required; straight-through → invalid (0R).
 */
import assert from 'node:assert/strict';
import { initPool, getPool, migrate, closePool } from '../../src/tracker/db.js';
process.env.TRACKER_DB = process.env.TRACKER_DB || 'memory';
await initPool();
import { createTrade, processTradeAtPrice } from '../../src/tracker/store.js';

const USER = 'e2e-entry-confirm';

async function main() {
  console.log('=== Entry confirm E2E ===');
  await migrate();
  const pool = getPool();
  await pool.query(`DELETE FROM tracker_trades WHERE user_id = $1`, [USER]);

  // LONG reclaim: entry 100, confirm 100, SL 90, TP 120/130
  const good = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'CONFUSDT',
    direction: 'LONG',
    grade: 'A',
    entry: 100,
    stopLoss: 90,
    targets: [120, 130],
    entryConfirmType: 'reclaim',
    entryConfirmLevel: 100,
    entryConfirmRationale: 'tag demand then reclaim 100',
    stopLiftTrigger: 110,
    stopLiftTo: 100,
  });

  let row = good;
  // Spike into zone
  let ev = await processTradeAtPrice(pool, row, 99);
  assert.ok(ev.some((e) => e.type === 'entry_armed'), 'should arm not open');
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [good.id])).rows[0];
  assert.equal(row.status, 'entry_armed');
  console.log('A PASS zone tag → entry_armed (not open)');

  // Reclaim
  ev = await processTradeAtPrice(pool, row, 100.5);
  assert.ok(ev.some((e) => e.type === 'entry_hit'));
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [good.id])).rows[0];
  assert.equal(row.status, 'entry_hit');
  console.log('B PASS reclaim → OPENED');

  // Straight-through path
  const bad = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'THRUUSDT',
    direction: 'LONG',
    grade: 'B',
    entry: 100,
    stopLoss: 90,
    targets: [120, 130],
    entryConfirmType: 'reclaim',
    entryConfirmLevel: 100,
  });
  row = bad;
  await processTradeAtPrice(pool, row, 99);
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [bad.id])).rows[0];
  assert.equal(row.status, 'entry_armed');
  // Wick into the zone (not through origin 90) — stay armed
  ev = await processTradeAtPrice(pool, row, 95);
  assert.ok(!ev.some((e) => e.type === 'entry_invalid'), 'FVG wick must not kill the idea');
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [bad.id])).rows[0];
  assert.equal(row.status, 'entry_armed');
  assert.equal(parseFloat(row.original_stop), 90);
  console.log('C PASS wick into zone → still armed (origin SL stays 90)');

  // Reclaim after sweep → OPEN with origin SL, not the wick
  ev = await processTradeAtPrice(pool, row, 100.5, undefined, { high: 100.5, low: 95 });
  assert.ok(ev.some((e) => e.type === 'entry_hit'));
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [bad.id])).rows[0];
  assert.equal(row.status, 'entry_hit');
  const originSl = parseFloat(row.original_stop);
  const liveSl = parseFloat(row.current_stop);
  assert.equal(originSl, 90, `origin SL must stay 90, got ${originSl}`);
  assert.equal(liveSl, 90, `live SL must stay origin 90, got ${liveSl}`);
  console.log('C2 PASS reclaim after sweep → OPEN origin SL', originSl);

  // Thesis-dead: sweep takes out the origin pivot without reclaim
  const dead = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'DEADUSDT',
    direction: 'LONG',
    grade: 'B',
    entry: 100,
    stopLoss: 90,
    targets: [120, 130],
    entryConfirmType: 'reclaim',
    entryConfirmLevel: 100,
  });
  await processTradeAtPrice(pool, dead, 99);
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [dead.id])).rows[0];
  ev = await processTradeAtPrice(pool, row, 60);
  assert.ok(ev.some((e) => e.type === 'entry_invalid'));
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [dead.id])).rows[0];
  assert.equal(row.status, 'entry_invalid');
  assert.equal(parseFloat(row.realized_r), 0);
  console.log('C3 PASS oversized sweep → entry_invalid 0R');

  // Touch mode still opens immediately
  const touch = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'TOUCHUSDT',
    direction: 'SHORT',
    grade: 'A',
    entry: 100,
    stopLoss: 110,
    targets: [90, 80],
    entryConfirmType: 'touch',
  });
  ev = await processTradeAtPrice(pool, touch, 101);
  assert.ok(ev.some((e) => e.type === 'entry_hit'));
  console.log('D PASS touch mode still opens on tag');

  console.log('\n✅ ENTRY CONFIRM E2E PASSED');
  await closePool();
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
