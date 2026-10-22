import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonFileCache } from '../src/cache/index.js';
import { normalizeBinanceSpotSymbol } from '../src/analysis/multiTf.js';
import { createXaiClient } from '../src/analysis/xaiClient.js';
import { tradeEmbeds } from '../src/lib/discordWebhook.js';

test('symbol normalisation', () => {
  assert.equal(normalizeBinanceSpotSymbol('btc'), 'BTCUSDT');
  assert.equal(normalizeBinanceSpotSymbol('XRPUSD'), 'XRPUSDT');
  assert.equal(normalizeBinanceSpotSymbol('XRPUSDT'), 'XRPUSDT');
});

test('json cache round-trips general rows and runs', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-'));
  const c = new JsonFileCache(dir, 2);
  assert.equal(await c.getGeneral('BTCUSDT', '1d_15m'), null);
  await c.setGeneral('BTCUSDT', '1d_15m', { aiNarration: { multiTFInsights: { overallSummary: 'x' } }, snapshots: [] });
  assert.equal((await c.getGeneral('BTCUSDT', '1d_15m'))?.aiNarration.multiTFInsights.overallSummary, 'x');
  for (const id of ['a', 'b', 'c']) await c.addRun({ id, trigger: 'cli', dryRun: true, result: {} });
  assert.deepEqual((await c.listRuns()).map((r) => r.id), ['c', 'b']);
});

test('mock xAI client returns parseable desk JSON', async () => {
  const client = createXaiClient('mock');
  const out = await client.chat.completions.create({
    messages: [{ role: 'system', content: 'desk' }, { role: 'user', content: '1d 15m\n- Price: $100, ATR(14): $2, RSI: 50' }],
  });
  const body = JSON.parse(out.choices[0].message.content);
  assert.equal(body.bestTrades.length, 1);
  assert.ok(body.bestTrades[0].entry < 100);
});

test('trade embeds render a priced setup', () => {
  const e = tradeEmbeds('BTCUSDT', [{ direction: 'LONG', grade: 'A', entry: 100, stopLoss: 95, targets: [110, 120], riskRewardRatio: 2 }]);
  assert.equal(e.length, 1);
  assert.match(String(e[0].title), /LONG/);
});
