/**
 * Pure engine: reclaim confirm keeps the origin pivot as SL / R, not the sweep wick.
 */
import assert from 'node:assert/strict';
import { evaluateTick, type EngineTrade } from '../../src/tracker/engine.js';

function baseLong(): EngineTrade {
  return {
    id: 't1',
    symbol: 'XRPUSDT',
    direction: 'LONG',
    grade: 'A',
    source: 'xrp_struct',
    entry: 1.4611,
    originalStop: 1.4343,
    currentStop: 1.4343,
    targets: [1.5196, 1.5675],
    entryConfirmType: 'reclaim',
    entryConfirmLevel: 1.4611,
    entryConfirmRationale: 'reclaim FVG high',
    stopLiftTrigger: null,
    stopLiftTo: null,
    stopLifted: false,
    remainingSize: 1,
    tp1ClosedSize: 0,
    stopToBe: false,
    status: 'pending',
    outcome: null,
    realizedR: 0,
    sweepExtreme: null,
  };
}

function apply(t: EngineTrade, evs: ReturnType<typeof evaluateTick>): EngineTrade {
  const ev = evs[evs.length - 1];
  if (!ev) return t;
  return {
    ...t,
    status: ev.newStatus,
    currentStop: ev.newCurrentStop,
    originalStop: ev.newOriginalStop ?? t.originalStop,
    remainingSize: ev.newRemainingSize,
    tp1ClosedSize: ev.newTp1ClosedSize,
    stopToBe: ev.newStopToBe,
    stopLifted: ev.newStopLifted,
    realizedR: ev.realizedRAfter,
    outcome: ev.outcome,
    sweepExtreme: ev.newSweepExtreme ?? t.sweepExtreme,
  };
}

console.log('=== engine origin-stop ===');

let t = baseLong();
t = apply(t, evaluateTick(t, 1.455, { high: 1.46, low: 1.455 }));
assert.equal(t.status, 'entry_armed');
assert.equal(t.originalStop, 1.4343);
assert.equal(t.currentStop, 1.4343);
console.log('A PASS tag FVG → armed, origin SL untouched');

t = apply(t, evaluateTick(t, 1.462, { high: 1.462, low: 1.455 }));
assert.equal(t.status, 'entry_hit');
assert.equal(t.originalStop, 1.4343, 'must not rewrite original_stop to sweep wick');
assert.equal(t.currentStop, 1.4343, 'live SL is origin, not wick');
console.log('B PASS reclaim → OPEN with origin SL 1.4343');

const noStop = evaluateTick(t, 1.456, { high: 1.46, low: 1.455 });
assert.equal(noStop.length, 0, 'retest of the FVG is not a stop');
console.log('C PASS FVG retest does not stop out');

const slEvs = evaluateTick(t, 1.43, { high: 1.44, low: 1.43 });
assert.ok(slEvs.some((e) => e.type === 'sl_hit' || e.type === 'be_hit'));
const sl = slEvs[slEvs.length - 1]!;
assert.ok(sl.realizedRAfter < -0.9 && sl.realizedRAfter > -1.1, `R should be ~-1, got ${sl.realizedRAfter}`);
console.log('D PASS origin taken → ~-1R (not a tick-stop lottery)');

const dead = apply(baseLong(), evaluateTick(baseLong(), 1.4, { high: 1.46, low: 1.4 }));
assert.equal(dead.status, 'entry_invalid');
assert.equal(dead.realizedR, 0);
console.log('E PASS sweep through origin without reclaim → invalid 0R');

console.log('\n✅ ENGINE ORIGIN-STOP PASSED');
