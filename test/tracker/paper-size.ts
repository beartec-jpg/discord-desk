import assert from 'node:assert/strict';
import { planPaperSize, type PaperAccount } from '../../src/tracker/paper.js';

const acct = (over: Partial<PaperAccount> = {}): PaperAccount => ({
  id: 'desk',
  starting: 1000,
  cash: 1000,
  lockedMargin: 0,
  equity: 1000,
  peak: 1000,
  riskPct: 0.0075,
  maxLeverage: 2,
  maxMarginFrac: 0.15,
  ...over,
});

console.log('=== paper size ===');

const wide = planPaperSize(acct(), 1.46, 1.43, 0); // 2.05% stop
assert.equal(wide.ok, true);
assert.ok(wide.riskUsd > 6 && wide.riskUsd < 9, `risk ~$7.50 got ${wide.riskUsd}`);
assert.ok(wide.leverage <= 2);
assert.ok(wide.margin / 1000 <= 0.15 + 1e-9);
console.log('A PASS origin-stop size risk', wide.riskUsd.toFixed(2), 'notional', wide.notional.toFixed(0), 'lev', wide.leverage);

const tight = planPaperSize(acct(), 1.46, 1.459, 0); // tiny stop — after cap, risk is pennies
assert.equal(tight.ok, false);
console.log('B PASS tick-stop rejected', tight.reason);

const halted = planPaperSize(acct({ equity: 700, peak: 1000 }), 1.46, 1.43, 0);
assert.equal(halted.ok, false);
assert.match(String(halted.reason), /halted/);
console.log('C PASS 25% DD halt');

const stacked = planPaperSize(acct(), 1.46, 1.43, 20);
assert.equal(stacked.ok, false);
console.log('D PASS open-risk cap');

console.log('\n✅ PAPER SIZE PASSED');
