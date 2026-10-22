# discord-desk

A standalone BTC / XRP AI trading desk. Once a day per coin it pulls market data from Binance, works out the indicators, asks Grok (xAI) for structured analysis and trade ideas, and posts the result to a Discord channel as embeds.

Plain Node + TypeScript. Its own scheduler, a CLI, a small local dashboard and a **bundled trade tracker** that follows every setup to entry, TP and stop on live Binance prices. No Vercel and no hosted database needed.

> ⚠️ **Not financial advice.** Output is AI-generated ideas for education and discussion only. Always check the chart yourself.

---

## How the analysis works

1. **Schedule.** By default BTCUSDT runs at 05:45 UTC and XRPUSDT at 05:50 UTC, before the London open. Each coin runs on its own, so the two never get mixed.
2. **Market data.** Candles come from Binance's public klines API (no exchange keys), with fallback endpoints. It fetches the higher timeframe (default `1d`), the lower timeframe (default `15m`) and weekly/monthly bars for macro levels.
3. **Indicators** (`computeIndicators` in `src/analysis/multiTf.ts`), per timeframe:
   - price, ATR(14), RSI, MACD (histogram and crossovers), Stochastic, ADX
   - volume profile (POC / VAH / VAL), VWAP, OBV
   - market structure: BOS / CHoCH, fair value gaps, order blocks, swing highs and lows
   - EMA 20 / 50 / 200, the Fib OTE zone (0.382–0.705), recent range
   - nearby weekly and monthly levels (far ones are filtered out)
4. **Context.**
   - A lighter "general" multi-timeframe read (bias, momentum, key levels, no trade plan). It is cached per symbol and pair, and the last 3 session snapshots (Asia / London / NY) are kept.
   - If a trade tracker is configured, the current **open book** of earlier ideas is included too.
5. **Grok gets text, not a chart.** The prompt is a numeric summary of everything above plus the trader-mode rules:
   - mode (default SMC/ICT) and horizon (default swing)
   - min R:R to TP1 (default 1.5) and min confluence (default 3, +1 for counter-trend)
   - stop beyond the origin swing of the zone, and never inside 0.5 × lower-TF ATR
   - wait for a reclaim confirmation (no blind market entries), plus stop-lift rules before TP1
   - keep or cancel every open-book idea before proposing new ones
   - answer in JSON only

   The primary model is `grok-4.6` with reasoning; it falls back to `grok-4-1-fast-reasoning` if that fails.
6. **Output.** Grok returns `multiTFInsights` (bias, summary and key levels per TF, plus macro), `bestTrades` (direction, grade, trigger zone and condition, entry, stop, targets, confirmation, stop lift, confluence, R:R, reasoning) and `openTradeReviews`. The code checks these against the gates (R:R, stop distance, structure), then builds the Discord message:
   - ① Deep-dive · ② Trade setups · ③ Cross-timeframe · ④ Open-book review · ⑤ Previous session · Disclaimer
7. **Trade tracker.** Cancels the stale ideas Grok marked, registers the new setups and then follows them (see below).

## Trade tracker

By default the tracker runs inside the same process. It exposes the API the desk uses and stores trades in an embedded Postgres (PGlite, a WASM build) under `DATA_DIR/tracker-db`, so there's no database to install. If you set `DATABASE_URL` it uses real Postgres with the same `src/tracker/schema.sql`.

**What it does** (`src/tracker/engine.ts`, `store.ts`):
- Polls Binance prices every `TRACKER_POLL_INTERVAL_MS` (15 s) and also uses the high/low wicks.
- **Entry confirm:** a setup is `pending` until price tags the zone (`entry_armed`), then opens only on a **reclaim** of the confirm level (`entry_hit`). A sweep far through the origin invalidates it at 0R.
- **Stop lift:** when `stopLiftTrigger` is tagged, the stop moves to `stopLiftTo` (usually break-even) before TP1.
- **TP1** closes 50% and moves the stop to BE. **TP2** closes the runner. Stop and BE exits are tracked in R.
- Discord pings for each event (armed, entry, stop lift, TP1, TP2, stop, cancel) go to the same per-coin webhook, plus a **weekly recap** on Sunday at 18:00 UTC (win rate, net R, PF, max DD, Sharpe/Sortino). Set `TRACKER_NOTIFY=0` to mute.
- **Paper account:** simulated equity with small risk per trade and capped leverage (`PAPER_*`).
- The engine processes one event per price tick, in order.

**API** (POST routes need `X-Tracker-Key` if `TRACKER_API_KEY` is set):

| Method | Path | |
|---|---|---|
| GET | `/health` | status |
| GET | `/api/trades?active=1&symbol=XRPUSDT&limit=50` | list trades |
| GET | `/api/performance?days=7` | stats |
| GET | `/api/weekly-preview` · `/api/paper` | weekly report preview · paper account |
| POST | `/api/trades` | register setup(s) `{source, userId, trades:[...]}` |
| POST | `/api/trades/cancel` | `{ids:[...], reason}` |
| POST | `/api/trades/:id/process` | evaluate one trade at `{price}` (testing) |
| POST | `/api/tick` | run an outcome pass now (optional `{prices:{SYMBOL:px}}` overrides) |
| POST | `/api/sim-price` · `/api/weekly` · `/api/paper/settings` | price override · post weekly · paper settings |

**Modes** (`TRACKER_MODE`):
- `bundled` (default): in-process. CLI runs open the same DB for the run. If the service is already running, the CLI says so: point it at the service with `TRACKER_URL=http://127.0.0.1:3000`.
- `external`: set `TRACKER_URL` (for example a tracker started with `npm run tracker`, or `docker compose --profile split`).
- `off`: no tracking.

## Setup

Needs Node 20+.

```bash
npm install
cp .env.example .env      # then fill in XAI_API_KEY and the webhooks
npm run build
```

## Running

```bash
# One-off run, print the Discord payload, don't post:
npm run desk -- --symbol XRPUSDT --dry-run
npm run desk -- --symbol BTCUSDT --dry-run

# Fully offline (no xAI key, mock model, still uses live Binance data):
npm run desk -- --symbol XRPUSDT --dry-run --mock     # or: npm run smoke

# Real run, posts to Discord:
npm run desk -- --symbol BTCUSDT

# Skip the Discord post but register the setups in the tracker, then run one outcome pass:
npm run desk -- --symbol XRPUSDT --no-post --check-outcomes

# Full JSON result:
npm run desk -- --symbol BTCUSDT --dry-run --json

# Long-running service (scheduler + dashboard + bundled tracker on http://127.0.0.1:3000):
npm start           # or `npm run dev` without building

# Tracker on its own (port TRACKER_PORT, default 3101):
npm run tracker
```

Dashboard: shows tracked trades with performance, recent runs, setups and the full Discord payload. **Run now** has three modes: dry run, track only (no post) and live. If you expose it beyond localhost, set `DASHBOARD_TOKEN` and open `/?token=...`.

Tests: `npm test` (unit tests plus the tracker engine, entry-confirm, stop-lift and paper-sizing suites on an in-memory DB). End-to-end: `npm run e2e` (mock model and live Binance: desk → tracker register → live outcome pass → forced entry/TP1/TP2 path → open-book review → cancel). Type check: `npm run typecheck`.

## Docker

```bash
cp .env.example .env   # fill in
docker compose up -d --build
# dashboard: http://127.0.0.1:3000
docker compose run --rm desk node dist/cli.js --symbol XRPUSDT --dry-run
```

Run history, the cache and the tracker DB live in the `desk-data` volume. `docker compose --profile split up -d` also starts a separate tracker container (then set `TRACKER_URL=http://tracker:3101`).

## Configuration

Every variable is listed and explained in [`.env.example`](.env.example). The main ones:

| Variable | Purpose |
|---|---|
| `XAI_API_KEY` | xAI key (or `XAI_MOCK=1` for offline) |
| `DISCORD_WEBHOOK_URL_BTC` / `_XRP` / `DISCORD_WEBHOOK_URL` | Channel webhooks (per coin, plus a fallback) |
| `DISCORD_AI_HIGHER_TF` / `DISCORD_AI_LOWER_TF` | Timeframes (`1d` / `15m`) |
| `DISCORD_AI_MODE` / `DISCORD_AI_HORIZON` | Trader mode / trade horizon |
| `DISCORD_MIN_RR` / `DISCORD_MIN_CONFLUENCE` | Gates |
| `DESK_SCHEDULE_BTC` / `DESK_SCHEDULE_XRP` / `DESK_SCHEDULE_TZ` | Cron schedules |
| `DATABASE_URL` | Optional Postgres cache (default: JSON file in `DATA_DIR`) |
| `TRACKER_MODE` / `TRACKER_URL` / `TRACKER_API_KEY` | Trade tracker (bundled by default) |
| `TRACKER_NOTIFY`, `WEEKLY_*`, `PAPER_*` | Tracker Discord pings, weekly recap, paper account |

## Improving it

| File | What's in it |
|---|---|
| `src/analysis/multiTf.ts` | Binance fetch, indicators, SMC structure, macro levels, prompts (`buildGeneralPrompt`, deep-dive prompt in `runSystemDeepDive`), JSON parsing and the quality gates. **Most of the edge lives here.** |
| `src/lib/aiTraderModes.ts` | Trader-mode system prompts and validity criteria (SMC, indicator, scalping, divergence, volume profile). |
| `src/lib/cryptoAiConfig.ts` | Horizons, sessions, timeframe pairs. |
| `src/desk.ts` | Orchestration: cache, open book, deep-dive, Discord embed layout, tracker calls. |
| `src/lib/discordWebhook.ts` | Embed formatting for trade setups and posting. |
| `src/analysis/xaiClient.ts` | xAI client and the offline mock. |
| `src/cache/index.ts` | JSON / Postgres cache and run history. |
| `src/tracker/engine.ts` | Trade lifecycle rules: entry confirm, stop lift, TP1/TP2, R accounting. |
| `src/tracker/store.ts`, `router.ts`, `service.ts` | Tracker DB, Discord pings, weekly report, HTTP API, poll loop. |
| `src/tracker/paper.ts`, `stats.ts` | Paper account sizing, performance stats. |
| `src/index.ts`, `src/cli.ts`, `src/web/` | Scheduler, CLI, dashboard. |

Tips:
- Use `--dry-run` while you iterate on prompts or gates, and compare payloads in the dashboard.
- Use `--mock` to work on the indicators and layout without spending tokens.
- The tracker's closed trades (`/api/performance`) tell you whether a prompt change actually helped.
- A useful next step would be a backtest harness: replay historical klines through `runSystemDeepDive` and score the setups.

## Disclaimer

This software is provided for education and research. It is **not financial advice**. Crypto trading carries substantial risk of loss. Make your own decisions.
