# discord-desk

A standalone BTC / XRP AI trading desk. Once a day per coin it pulls market data from Binance, works out the indicators, asks Grok (xAI) for structured analysis and trade ideas, and posts the result to a Discord channel as embeds.

Plain Node + TypeScript. Its own scheduler, a CLI, and a small local dashboard. No Vercel and no hosted database needed.

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
7. **Tracker (optional).** Cancels stale ideas and registers new ones.

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

# Full JSON result:
npm run desk -- --symbol BTCUSDT --dry-run --json

# Long-running service (scheduler + dashboard on http://127.0.0.1:3000):
npm start           # or `npm run dev` without building
```

Dashboard: shows recent runs, setups and the full Discord payload, with a **Run now** button (dry run by default). If you expose it beyond localhost, set `DASHBOARD_TOKEN` and open `/?token=...`.

Tests: `npm test`. Type check: `npm run typecheck`.

## Docker

```bash
cp .env.example .env   # fill in
docker compose up -d --build
# dashboard: http://127.0.0.1:3000
docker compose run --rm desk node dist/cli.js --symbol XRPUSDT --dry-run
```

Run history and the cache live in the `desk-data` volume.

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
| `TRACKER_URL` / `TRACKER_API_KEY` | Optional trade tracker |

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
| `src/index.ts`, `src/cli.ts`, `src/web/` | Scheduler, CLI, dashboard. |

Tips:
- Use `--dry-run` while you iterate on prompts or gates, and compare payloads in the dashboard.
- Use `--mock` to work on the indicators and layout without spending tokens.
- A useful next step would be a backtest harness: replay historical klines through `runSystemDeepDive` and score the setups.

## Disclaimer

This software is provided for education and research. It is **not financial advice**. Crypto trading carries substantial risk of loss. Make your own decisions.
