/**
 * Paper account: $1000 start, small fixed-fraction risk, capped leverage.
 * Goal is consistent compounding, not max notional.
 *
 * Size: risk PAPER_RISK_PCT of equity to the origin stop.
 * Leverage: user pick (default 2x), never more than PAPER_MAX_LEVERAGE,
 * and never more than PAPER_MAX_MARGIN_FRAC of equity as margin.
 */

import type { Queryable } from './db.js';
import type { EngineEvent, EngineTrade } from './engine.js';

export interface PaperConfig {
  starting: number;
  riskPct: number;
  maxLeverage: number;
  maxMarginFrac: number;
  maxOpenRiskPct: number;
  haltDrawdownPct: number;
  sources: string[];
}

export interface PaperSizePlan {
  ok: boolean;
  reason?: string;
  baseQty: number;
  notional: number;
  margin: number;
  leverage: number;
  riskUsd: number;
  stopDist: number;
}

export interface PaperAccount {
  id: string;
  starting: number;
  cash: number;
  lockedMargin: number;
  equity: number;
  peak: number;
  riskPct: number;
  maxLeverage: number;
  maxMarginFrac: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export function loadPaperConfig(): PaperConfig {
  const sources = (process.env.PAPER_SOURCES || 'discord_desk')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    starting: Math.max(100, Number(process.env.PAPER_STARTING_EQUITY || 1000) || 1000),
    riskPct: clamp(Number(process.env.PAPER_RISK_PCT || 0.0075) || 0.0075, 0.001, 0.03),
    maxLeverage: clamp(Number(process.env.PAPER_MAX_LEVERAGE || 2) || 2, 1, 5),
    maxMarginFrac: clamp(Number(process.env.PAPER_MAX_MARGIN_FRAC || 0.2) || 0.2, 0.05, 0.4),
    maxOpenRiskPct: clamp(Number(process.env.PAPER_MAX_OPEN_RISK_PCT || 0.02) || 0.02, 0.005, 0.08),
    haltDrawdownPct: clamp(Number(process.env.PAPER_HALT_DD_PCT || 0.25) || 0.25, 0.1, 0.6),
    sources,
  };
}

function paperSource(src: string | undefined): boolean {
  const cfg = loadPaperConfig();
  return cfg.sources.includes(String(src || ''));
}

export function planPaperSize(
  acct: PaperAccount,
  entry: number,
  stop: number,
  openRiskUsd: number,
): PaperSizePlan {
  const cfg = loadPaperConfig();
  const stopDist = Math.abs(entry - stop);
  if (!(entry > 0) || !(stopDist > 0)) {
    return { ok: false, reason: 'bad entry/stop', baseQty: 0, notional: 0, margin: 0, leverage: cfg.maxLeverage, riskUsd: 0, stopDist };
  }
  const dd = acct.peak > 0 ? (acct.peak - acct.equity) / acct.peak : 0;
  if (dd >= cfg.haltDrawdownPct) {
    return { ok: false, reason: `halted: drawdown ${(dd * 100).toFixed(1)}%`, baseQty: 0, notional: 0, margin: 0, leverage: cfg.maxLeverage, riskUsd: 0, stopDist };
  }
  const riskUsd = acct.equity * acct.riskPct;
  if (openRiskUsd + riskUsd > acct.equity * cfg.maxOpenRiskPct + 1e-9) {
    return { ok: false, reason: 'open risk cap', baseQty: 0, notional: 0, margin: 0, leverage: cfg.maxLeverage, riskUsd, stopDist };
  }
  let baseQty = riskUsd / stopDist;
  let notional = baseQty * entry;
  const maxNotional = acct.equity * acct.maxMarginFrac * acct.maxLeverage;
  if (notional > maxNotional) {
    notional = maxNotional;
    baseQty = notional / entry;
  }
  const leverage = acct.maxLeverage;
  let margin = notional / leverage;
  const cashCap = Math.max(0, acct.cash) * 0.9;
  if (margin > cashCap && cashCap > 0) {
    const scale = cashCap / margin;
    baseQty *= scale;
    notional *= scale;
    margin *= scale;
  }
  const actualRisk = baseQty * stopDist;
  if (margin < 1 || actualRisk < 0.5 || baseQty <= 0) {
    return { ok: false, reason: 'size too small', baseQty: 0, notional: 0, margin: 0, leverage, riskUsd: actualRisk, stopDist };
  }
  return { ok: true, baseQty, notional, margin, leverage, riskUsd: actualRisk, stopDist };
}

export async function ensurePaperAccount(pool: Queryable): Promise<PaperAccount> {
  const cfg = loadPaperConfig();
  const ins = await pool.query(
    `INSERT INTO paper_account (id, starting, cash, locked_margin, equity, peak, risk_pct, max_leverage, max_margin_frac)
     VALUES ('desk', $1, $1, 0, $1, $1, $2, $3, $4)
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [cfg.starting, cfg.riskPct, cfg.maxLeverage, cfg.maxMarginFrac],
  );
  const row = await loadAccount(pool);
  if (!row) throw new Error('paper account missing');
  if (ins.rowCount) {
    await snapshot(pool, row, null, true);
  }
  return row;
}

async function loadAccount(pool: Queryable): Promise<PaperAccount | null> {
  const r = await pool.query(
    `SELECT id, starting, cash, locked_margin, equity, peak, risk_pct, max_leverage, max_margin_frac
     FROM paper_account WHERE id = 'desk'`,
  );
  const row = r.rows[0];
  if (!row) return null;
  return {
    id: 'desk',
    starting: Number(row.starting),
    cash: Number(row.cash),
    lockedMargin: Number(row.locked_margin),
    equity: Number(row.equity),
    peak: Number(row.peak),
    riskPct: Number(row.risk_pct),
    maxLeverage: Number(row.max_leverage),
    maxMarginFrac: Number(row.max_margin_frac),
  };
}

async function saveAccount(pool: Queryable, acct: PaperAccount): Promise<void> {
  const peak = Math.max(acct.peak, acct.equity);
  await pool.query(
    `UPDATE paper_account SET cash=$2, locked_margin=$3, equity=$4, peak=$5,
            risk_pct=$6, max_leverage=$7, max_margin_frac=$8, updated_at=NOW()
     WHERE id=$1`,
    [acct.id, acct.cash, acct.lockedMargin, acct.equity, peak, acct.riskPct, acct.maxLeverage, acct.maxMarginFrac],
  );
  acct.peak = peak;
}

async function openRiskUsd(pool: Queryable): Promise<number> {
  const r = await pool.query(
    `SELECT COALESCE(SUM(base_qty * ABS(entry - stop)), 0) AS risk
     FROM paper_positions WHERE remaining_qty > 0`,
  );
  return Number(r.rows[0]?.risk || 0);
}

async function insertFill(
  pool: Queryable,
  row: {
    tradeId: string;
    event: string;
    qty: number;
    price: number;
    pnl: number;
    equityAfter: number;
    note?: string;
  },
): Promise<void> {
  await pool.query(
    `INSERT INTO paper_fills (trade_id, event, qty, price, pnl, equity_after, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [row.tradeId, row.event, row.qty, row.price, row.pnl, row.equityAfter, row.note || null],
  );
}

async function snapshot(
  pool: Queryable,
  acct: PaperAccount,
  xrpPrice: number | null,
  force = false,
): Promise<void> {
  if (!force) {
    const last = await pool.query(
      `SELECT ts, equity FROM paper_equity ORDER BY ts DESC LIMIT 1`,
    );
    const prev = last.rows[0];
    if (prev) {
      const age = Date.now() - new Date(prev.ts).getTime();
      const chg = Math.abs(Number(prev.equity) - acct.equity) / Math.max(acct.equity, 1);
      if (age < 50_000 && chg < 0.001) return;
    }
  }
  const open = await pool.query(
    `SELECT COALESCE(SUM(remaining_qty * entry), 0) AS notional FROM paper_positions WHERE remaining_qty > 0`,
  );
  const dd = acct.peak > 0 ? (acct.peak - acct.equity) / acct.peak : 0;
  await pool.query(
    `INSERT INTO paper_equity (ts, equity, cash, locked_margin, open_notional, xrp_price, drawdown_pct)
     VALUES (NOW(), $1, $2, $3, $4, $5, $6)`,
    [acct.equity, acct.cash, acct.lockedMargin, Number(open.rows[0]?.notional || 0), xrpPrice, dd],
  );
  await pool.query(
    `DELETE FROM paper_equity WHERE id IN (
       SELECT id FROM (
         SELECT id, row_number() OVER (ORDER BY ts DESC) AS rn FROM paper_equity
       ) t WHERE rn > 2500
     )`,
  );
}

function dirSign(direction: string): number {
  return String(direction).toUpperCase() === 'SHORT' ? -1 : 1;
}

export async function applyPaperEvent(
  pool: Queryable,
  trade: EngineTrade,
  ev: EngineEvent,
): Promise<void> {
  if (!paperSource(trade.source)) return;
  const acct = await ensurePaperAccount(pool);
  const px = Number(ev.price);
  if (!Number.isFinite(px) || px <= 0) return;

  if (ev.type === 'entry_hit') {
    const existing = await pool.query(`SELECT trade_id FROM paper_positions WHERE trade_id = $1`, [trade.id]);
    if (existing.rows[0]) return;
    const openRisk = await openRiskUsd(pool);
    const plan = planPaperSize(acct, trade.entry, trade.originalStop, openRisk);
    if (!plan.ok) {
      console.log(`[paper] skip open ${trade.symbol} ${trade.id.slice(0, 8)}: ${plan.reason}`);
      return;
    }
    acct.cash -= plan.margin;
    acct.lockedMargin += plan.margin;
    acct.equity = acct.cash + acct.lockedMargin;
    await saveAccount(pool, acct);
    await pool.query(
      `INSERT INTO paper_positions (
         trade_id, symbol, source, direction, entry, stop, base_qty, remaining_qty,
         notional, margin, leverage, risk_usd
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11)`,
      [
        trade.id,
        trade.symbol,
        trade.source || '',
        trade.direction,
        trade.entry,
        trade.originalStop,
        plan.baseQty,
        plan.notional,
        plan.margin,
        plan.leverage,
        plan.riskUsd,
      ],
    );
    await insertFill(pool, {
      tradeId: trade.id,
      event: 'open',
      qty: plan.baseQty,
      price: trade.entry,
      pnl: 0,
      equityAfter: acct.equity,
      note: `lev=${plan.leverage} margin=${plan.margin.toFixed(2)} risk=${plan.riskUsd.toFixed(2)}`,
    });
    await snapshot(pool, acct, px, true);
    console.log(
      `[paper] OPEN ${trade.symbol} ${trade.direction} qty=${plan.baseQty.toFixed(4)} notional=$${plan.notional.toFixed(0)} lev=${plan.leverage}x risk=$${plan.riskUsd.toFixed(2)} equity=$${acct.equity.toFixed(2)}`,
    );
    return;
  }

  const posQ = await pool.query(`SELECT * FROM paper_positions WHERE trade_id = $1`, [trade.id]);
  const pos = posQ.rows[0];
  if (!pos) return;

  const closeFrac =
    ev.type === 'tp1_hit'
      ? 0.5
      : ev.type === 'tp2_hit' || ev.type === 'sl_hit' || ev.type === 'be_hit'
        ? 1
        : 0;
  if (closeFrac <= 0) return;

  const remaining = Number(pos.remaining_qty);
  const closeQty = remaining * closeFrac;
  if (closeQty <= 0) return;
  const sign = dirSign(String(pos.direction));
  const pnl = closeQty * (px - Number(pos.entry)) * sign;
  const marginSlice = Number(pos.margin) * (closeQty / Number(pos.base_qty));
  acct.lockedMargin = Math.max(0, acct.lockedMargin - marginSlice);
  acct.cash += marginSlice + pnl;
  const left = remaining - closeQty;
  await pool.query(
    `UPDATE paper_positions SET remaining_qty = $2, updated_at = NOW() WHERE trade_id = $1`,
    [trade.id, left],
  );
  acct.equity = acct.cash + acct.lockedMargin;
  await saveAccount(pool, acct);
  await insertFill(pool, {
    tradeId: trade.id,
    event: ev.type,
    qty: closeQty,
    price: px,
    pnl,
    equityAfter: acct.equity,
  });
  await snapshot(pool, acct, px, true);
  console.log(
    `[paper] ${ev.type} ${trade.symbol} pnl=${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} equity=$${acct.equity.toFixed(2)}`,
  );
}

export async function markPaperToMarket(pool: Queryable, prices: Map<string, number>): Promise<void> {
  const acct = await ensurePaperAccount(pool);
  const pos = await pool.query(`SELECT * FROM paper_positions WHERE remaining_qty > 0`);
  let uPnl = 0;
  for (const p of pos.rows) {
    const mark = prices.get(String(p.symbol).toUpperCase());
    if (mark == null) continue;
    uPnl += Number(p.remaining_qty) * (mark - Number(p.entry)) * dirSign(String(p.direction));
  }
  acct.equity = acct.cash + acct.lockedMargin + uPnl;
  await saveAccount(pool, acct);
  const xrp = prices.get('XRPUSDT') ?? prices.get('XRPUSD') ?? null;
  await snapshot(pool, acct, xrp, pos.rows.length > 0);
}

export async function updatePaperSettings(
  pool: Queryable,
  patch: { riskPct?: number; maxLeverage?: number; maxMarginFrac?: number },
): Promise<PaperAccount> {
  const acct = await ensurePaperAccount(pool);
  if (patch.riskPct != null) acct.riskPct = clamp(Number(patch.riskPct), 0.001, 0.03);
  if (patch.maxLeverage != null) acct.maxLeverage = clamp(Number(patch.maxLeverage), 1, 5);
  if (patch.maxMarginFrac != null) acct.maxMarginFrac = clamp(Number(patch.maxMarginFrac), 0.05, 0.4);
  await saveAccount(pool, acct);
  return acct;
}

export async function getPaperDashboard(pool: Queryable) {
  const acct = await ensurePaperAccount(pool);
  const pos = await pool.query(
    `SELECT trade_id, symbol, source, direction, entry, stop, base_qty, remaining_qty,
            notional, margin, leverage, risk_usd, opened_at
     FROM paper_positions WHERE remaining_qty > 0 ORDER BY opened_at DESC`,
  );
  const fills = await pool.query(
    `SELECT event, qty, price, pnl, equity_after, created_at, trade_id
     FROM paper_fills ORDER BY created_at DESC LIMIT 40`,
  );
  const curve = await pool.query(
    `SELECT EXTRACT(EPOCH FROM ts)::bigint AS t, equity, xrp_price, drawdown_pct, open_notional
     FROM paper_equity ORDER BY ts ASC LIMIT 2500`,
  );
  const pnl = acct.equity - acct.starting;
  const dd = acct.peak > 0 ? (acct.peak - acct.equity) / acct.peak : 0;
  return {
    account: {
      starting: acct.starting,
      cash: round2(acct.cash),
      lockedMargin: round2(acct.lockedMargin),
      equity: round2(acct.equity),
      peak: round2(acct.peak),
      pnl: round2(pnl),
      pnlPct: acct.starting ? pnl / acct.starting : 0,
      drawdownPct: dd,
      riskPct: acct.riskPct,
      maxLeverage: acct.maxLeverage,
      maxMarginFrac: acct.maxMarginFrac,
    },
    rules: {
      riskPerTrade: `${(acct.riskPct * 100).toFixed(2)}% of equity to origin stop`,
      leverage: `${acct.maxLeverage}x cap`,
      maxMargin: `${(acct.maxMarginFrac * 100).toFixed(0)}% of equity as margin`,
      maxOpenRisk: `${(loadPaperConfig().maxOpenRiskPct * 100).toFixed(1)}% total open risk`,
      halt: `pause new paper opens at ${(loadPaperConfig().haltDrawdownPct * 100).toFixed(0)}% peak drawdown`,
    },
    positions: pos.rows,
    fills: fills.rows,
    equityCurve: curve.rows.map((r) => ({
      t: Number(r.t),
      equity: Number(r.equity),
      xrp: r.xrp_price != null ? Number(r.xrp_price) : null,
      dd: Number(r.drawdown_pct || 0),
    })),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
