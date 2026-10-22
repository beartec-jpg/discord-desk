import cron from 'node-cron';
import { config, isMock } from './config.js';
import { createCache } from './cache/index.js';
import { runAndRecord } from './runner.js';
import { createServer } from './web/server.js';

const cache = createCache();
const dryRun = ['1', 'true'].includes((process.env.DESK_DRY_RUN || '').toLowerCase());

const jobs: Array<{ symbol: string; schedule: string }> = [
  { symbol: 'BTCUSDT', schedule: config.scheduleBtc },
  { symbol: 'XRPUSDT', schedule: config.scheduleXrp },
];
for (const extra of (process.env.DESK_EXTRA_SCHEDULES || '').split(';').map((s) => s.trim()).filter(Boolean)) {
  // format: SYMBOL=cron expr   e.g. ETHUSDT=55 5 * * *
  const [sym, expr] = extra.split('=');
  if (sym && expr) jobs.push({ symbol: sym.trim().toUpperCase(), schedule: expr.trim() });
}

const schedules: Record<string, string> = {};
for (const job of jobs) {
  if (!job.schedule || job.schedule === 'off') {
    console.log(`⏸  ${job.symbol} schedule disabled`);
    continue;
  }
  if (!cron.validate(job.schedule)) {
    console.error(`Invalid cron for ${job.symbol}: "${job.schedule}"`);
    process.exit(1);
  }
  schedules[job.symbol] = `${job.schedule} (${config.scheduleTz})`;
  cron.schedule(
    job.schedule,
    async () => {
      console.log(`⏰ Scheduled run ${job.symbol}`);
      const r = await runAndRecord(cache, job.symbol, { dryRun, trigger: 'schedule' });
      console.log(`⏰ ${job.symbol} finished success=${r.success}`);
    },
    { timezone: config.scheduleTz },
  );
  console.log(`🗓  ${job.symbol} scheduled: ${job.schedule} ${config.scheduleTz}`);
}

if ((process.env.DASHBOARD || 'on') !== 'off') {
  const app = createServer(cache, {
    model: process.env.XAI_PRIMARY_MODEL || 'grok-4.6',
    mock: isMock(),
    cache: cache.kind,
    schedules,
    dryRunSchedule: dryRun,
    webhooks: ['BTC', 'XRP'].filter((b) => process.env[`DISCORD_WEBHOOK_URL_${b}`]).join(',') || (process.env.DISCORD_WEBHOOK_URL ? 'shared' : 'none'),
    tracker: process.env.TRACKER_URL ? 'on' : 'off',
  });
  app.listen(config.port, config.host, () => console.log(`🖥  Dashboard on http://${config.host}:${config.port}`));
}
