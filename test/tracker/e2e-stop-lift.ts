/**
 * Stop-lift path: entry → tag lift trigger → SL moves to BE/profit → reverse hits new stop.
 */
import assert from 'node:assert/strict';
import { initPool, getPool, migrate, closePool } from '../../src/tracker/db.js';
process.env.TRACKER_DB = process.env.TRACKER_DB || 'memory';
await initPool();
import { createTrade, processTradeAtPrice } from '../../src/tracker/store.js';

const USER = 'e2e-stop-lift';

async function main() {
  console.log('=== Stop-lift E2E ===');
  await migrate();
  const pool = getPool();
  await pool.query(`DELETE FROM tracker_trades WHERE user_id = $1`, [USER]);

  // LONG: entry 100, SL 90, TP1 120, TP2 130
  // Lift trigger 110 (local high), lift to 100 (BE)
  const t = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'LIFTUSDT',
    direction: 'LONG',
    grade: 'A',
    entry: 100,
    stopLoss: 90,
    targets: [120, 130],
    entryConfirmType: 'touch', // isolate stop-lift path
    stopLiftTrigger: 110,
    stopLiftTo: 100,
    stopLiftRationale: 'reclaim local high then BE',
  });
  assert.ok(t.stop_lift_trigger != null, 'stop_lift_trigger stored');

  let row = t;
  await processTradeAtPrice(pool, row, 100); // entry
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t.id])).rows[0];
  assert.equal(row.status, 'entry_hit');
  assert.equal(Boolean(row.stop_lifted), false);

  // Tag lift trigger — no size closed
  let ev = await processTradeAtPrice(pool, row, 110);
  assert.ok(ev.some((e) => e.type === 'stop_lift'), 'expected stop_lift');
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t.id])).rows[0];
  assert.equal(Boolean(row.stop_lifted), true);
  assert.equal(parseFloat(row.current_stop), 100);
  assert.equal(parseFloat(row.remaining_size), 1);
  assert.equal(parseFloat(row.realized_r), 0);
  console.log('A PASS stop lifted to BE after trigger, size still 100%');

  // Reverse to BE stop — scratch exit
  ev = await processTradeAtPrice(pool, row, 100);
  assert.ok(ev.some((e) => e.type === 'be_hit' || e.type === 'sl_hit'));
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t.id])).rows[0];
  assert.ok(['be_hit', 'sl_hit'].includes(row.status));
  assert.ok(Math.abs(parseFloat(row.realized_r)) < 0.05);
  console.log('B PASS BE stop exit ~0R (protected from original SL)');

  // Profit lock path
  const t2 = await createTrade(pool, {
    userId: USER,
    source: 'sim',
    symbol: 'LIFT2USDT',
    direction: 'LONG',
    grade: 'A',
    entry: 100,
    stopLoss: 90,
    targets: [120, 130],
    entryConfirmType: 'touch',
    stopLiftTrigger: 110,
    stopLiftTo: 102, // small lock-in
  });
  row = t2;
  await processTradeAtPrice(pool, row, 99);
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t2.id])).rows[0];
  await processTradeAtPrice(pool, row, 110);
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t2.id])).rows[0];
  assert.equal(parseFloat(row.current_stop), 102);
  await processTradeAtPrice(pool, row, 102);
  row = (await pool.query(`SELECT * FROM tracker_trades WHERE id=$1`, [t2.id])).rows[0];
  assert.ok(parseFloat(row.realized_r) > 0);
  console.log('C PASS profit-lock stop exit +R', row.realized_r);

  console.log('\n✅ STOP-LIFT E2E PASSED');
  await closePool();
}

main().catch((e) => {
  console.error('❌', e);
  process.exit(1);
});
