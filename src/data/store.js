/**
 * SQLite persistence — the system's memory.
 *
 * Everything needed to survive a restart or learn from the past lives here:
 * cached candles for replay, every signal produced, orders and fills, closed
 * trades with realized PnL, external source track records, and the
 * conviction-to-outcome calibration table.
 *
 * Uses node:sqlite (built into Node 22+) so deployment needs no native build.
 */

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS candles (
  symbol     TEXT    NOT NULL,
  timeframe  TEXT    NOT NULL,
  open_time  INTEGER NOT NULL,
  open       REAL    NOT NULL,
  high       REAL    NOT NULL,
  low        REAL    NOT NULL,
  close      REAL    NOT NULL,
  volume     REAL    NOT NULL,
  quote_vol  REAL,
  trades     INTEGER,
  closed     INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (symbol, timeframe, open_time)
);
CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(symbol, timeframe, open_time DESC);

CREATE TABLE IF NOT EXISTS signals (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        TEXT    NOT NULL,
  ts            INTEGER NOT NULL,
  symbol        TEXT    NOT NULL,
  side          TEXT    NOT NULL,
  entry         REAL,
  stop_loss     REAL,
  tp1           REAL,
  tp2           REAL,
  tp3           REAL,
  regime        TEXT,
  conviction_raw REAL,
  conviction_cal REAL,
  grade         TEXT,
  acted         INTEGER NOT NULL DEFAULT 0,
  veto_reason   TEXT,
  features      TEXT,
  layers        TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_signals_ts     ON signals(ts DESC);
CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol, ts DESC);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id        INTEGER REFERENCES signals(id),
  client_order_id  TEXT    NOT NULL UNIQUE,
  exchange_order_id TEXT,
  symbol           TEXT    NOT NULL,
  side             TEXT    NOT NULL,
  type             TEXT    NOT NULL,
  qty              REAL    NOT NULL,
  price            REAL,
  status           TEXT    NOT NULL,
  purpose          TEXT,
  ts               INTEGER NOT NULL,
  updated_at       INTEGER
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);

CREATE TABLE IF NOT EXISTS fills (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id          INTEGER REFERENCES orders(id),
  exchange_trade_id TEXT UNIQUE,
  symbol            TEXT    NOT NULL,
  side              TEXT    NOT NULL,
  qty               REAL    NOT NULL,
  price             REAL    NOT NULL,
  fee               REAL    NOT NULL DEFAULT 0,
  fee_asset         TEXT,
  ts                INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fills_symbol ON fills(symbol, ts DESC);

CREATE TABLE IF NOT EXISTS trades (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id   INTEGER REFERENCES signals(id),
  symbol      TEXT    NOT NULL,
  side        TEXT    NOT NULL,
  qty         REAL    NOT NULL,
  entry_px    REAL    NOT NULL,
  exit_px     REAL,
  entry_ts    INTEGER NOT NULL,
  exit_ts     INTEGER,
  gross_pnl   REAL,
  fees        REAL    NOT NULL DEFAULT 0,
  funding     REAL    NOT NULL DEFAULT 0,
  net_pnl     REAL,
  r_multiple  REAL,
  mae_r       REAL,
  mfe_r       REAL,
  exit_reason TEXT,
  regime      TEXT,
  status      TEXT    NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
CREATE INDEX IF NOT EXISTS idx_trades_exit   ON trades(exit_ts DESC);

CREATE TABLE IF NOT EXISTS sources (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT    NOT NULL,
  handle     TEXT    NOT NULL,
  label      TEXT,
  first_seen INTEGER NOT NULL,
  status     TEXT    NOT NULL DEFAULT 'observing',
  weight     REAL    NOT NULL DEFAULT 0,
  UNIQUE (kind, handle)
);

CREATE TABLE IF NOT EXISTS source_calls (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id  INTEGER NOT NULL REFERENCES sources(id),
  ts         INTEGER NOT NULL,
  symbol     TEXT    NOT NULL,
  direction  TEXT    NOT NULL,
  horizon_h  INTEGER NOT NULL,
  raw_text   TEXT,
  price_at_call REAL,
  resolve_at INTEGER NOT NULL,
  resolved   INTEGER NOT NULL DEFAULT 0,
  outcome    TEXT,
  return_pct REAL
);
CREATE INDEX IF NOT EXISTS idx_calls_pending ON source_calls(resolved, resolve_at);

CREATE TABLE IF NOT EXISTS source_scores (
  source_id    INTEGER PRIMARY KEY REFERENCES sources(id),
  n_resolved   INTEGER NOT NULL DEFAULT 0,
  n_correct    INTEGER NOT NULL DEFAULT 0,
  hit_rate     REAL,
  wilson_lb    REAL,
  avg_return   REAL,
  weight       REAL    NOT NULL DEFAULT 0,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS calibration (
  bucket      INTEGER NOT NULL,
  regime      TEXT    NOT NULL,
  n           INTEGER NOT NULL DEFAULT 0,
  n_win       INTEGER NOT NULL DEFAULT 0,
  realized_wr REAL,
  avg_r       REAL,
  updated_at  INTEGER,
  PRIMARY KEY (bucket, regime)
);

CREATE TABLE IF NOT EXISTS risk_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  layer      TEXT    NOT NULL,
  model      TEXT    NOT NULL,
  in_tok     INTEGER NOT NULL DEFAULT 0,
  out_tok    INTEGER NOT NULL DEFAULT 0,
  cached_tok INTEGER NOT NULL DEFAULT 0,
  cost_usd   REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_ts ON ai_usage(ts DESC);
`;

export class Store {
  constructor(dbPath = "./data/trader.db") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  close() { this.db.close(); }

  // ── CANDLES ───────────────────────────────────────────────────────────────

  upsertCandles(symbol, timeframe, candles) {
    const stmt = this.db.prepare(`
      INSERT INTO candles (symbol, timeframe, open_time, open, high, low, close, volume, quote_vol, trades, closed)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(symbol, timeframe, open_time) DO UPDATE SET
        high = excluded.high, low = excluded.low, close = excluded.close,
        volume = excluded.volume, quote_vol = excluded.quote_vol,
        trades = excluded.trades, closed = excluded.closed
    `);
    this.db.exec("BEGIN");
    try {
      for (const c of candles) {
        stmt.run(symbol, timeframe, c.openTime, c.open, c.high, c.low, c.close,
                 c.volume, c.quoteVol ?? null, c.trades ?? null, c.closed ? 1 : 0);
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return candles.length;
  }

  getCandles(symbol, timeframe, { limit = 500, before, after } = {}) {
    let sql = `SELECT * FROM candles WHERE symbol = ? AND timeframe = ? AND closed = 1`;
    const args = [symbol, timeframe];
    if (before !== undefined) { sql += ` AND open_time < ?`; args.push(before); }
    if (after  !== undefined) { sql += ` AND open_time > ?`; args.push(after); }
    sql += ` ORDER BY open_time DESC LIMIT ?`;
    args.push(limit);
    return this.db.prepare(sql).all(...args).reverse();
  }

  latestCandleTime(symbol, timeframe) {
    const row = this.db.prepare(
      `SELECT MAX(open_time) AS t FROM candles WHERE symbol = ? AND timeframe = ?`
    ).get(symbol, timeframe);
    return row?.t ?? null;
  }

  candleCount(symbol, timeframe) {
    return this.db.prepare(
      `SELECT COUNT(*) AS n FROM candles WHERE symbol = ? AND timeframe = ?`
    ).get(symbol, timeframe).n;
  }

  // ── SIGNALS ───────────────────────────────────────────────────────────────

  insertSignal(sig) {
    const r = this.db.prepare(`
      INSERT INTO signals (run_id, ts, symbol, side, entry, stop_loss, tp1, tp2, tp3,
                           regime, conviction_raw, conviction_cal, grade, acted,
                           veto_reason, features, layers, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      sig.runId, sig.ts, sig.symbol, sig.side,
      sig.entry ?? null, sig.stopLoss ?? null,
      sig.tp1 ?? null, sig.tp2 ?? null, sig.tp3 ?? null,
      sig.regime ?? null, sig.convictionRaw ?? null, sig.convictionCal ?? null,
      sig.grade ?? null, sig.acted ? 1 : 0, sig.vetoReason ?? null,
      sig.features ? JSON.stringify(sig.features) : null,
      sig.layers   ? JSON.stringify(sig.layers)   : null,
      Date.now()
    );
    return Number(r.lastInsertRowid);
  }

  markSignalActed(signalId, acted, vetoReason = null) {
    this.db.prepare(`UPDATE signals SET acted = ?, veto_reason = ? WHERE id = ?`)
      .run(acted ? 1 : 0, vetoReason, signalId);
  }

  recentSignals({ limit = 100 } = {}) {
    return this.db.prepare(`SELECT * FROM signals ORDER BY ts DESC LIMIT ?`).all(limit);
  }

  // ── ORDERS / FILLS ────────────────────────────────────────────────────────

  insertOrder(o) {
    const r = this.db.prepare(`
      INSERT INTO orders (signal_id, client_order_id, exchange_order_id, symbol, side,
                          type, qty, price, status, purpose, ts, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      o.signalId ?? null, o.clientOrderId, o.exchangeOrderId ?? null,
      o.symbol, o.side, o.type, o.qty, o.price ?? null,
      o.status, o.purpose ?? null, o.ts, Date.now()
    );
    return Number(r.lastInsertRowid);
  }

  updateOrderStatus(clientOrderId, status, exchangeOrderId) {
    this.db.prepare(`
      UPDATE orders SET status = ?, exchange_order_id = COALESCE(?, exchange_order_id), updated_at = ?
      WHERE client_order_id = ?
    `).run(status, exchangeOrderId ?? null, Date.now(), clientOrderId);
  }

  getOrderByClientId(clientOrderId) {
    return this.db.prepare(`SELECT * FROM orders WHERE client_order_id = ?`).get(clientOrderId);
  }

  openOrders() {
    return this.db.prepare(
      `SELECT * FROM orders WHERE status IN ('NEW','PARTIALLY_FILLED') ORDER BY ts DESC`
    ).all();
  }

  insertFill(f) {
    const r = this.db.prepare(`
      INSERT OR IGNORE INTO fills (order_id, exchange_trade_id, symbol, side, qty, price, fee, fee_asset, ts)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(f.orderId ?? null, f.exchangeTradeId ?? null, f.symbol, f.side,
           f.qty, f.price, f.fee ?? 0, f.feeAsset ?? null, f.ts);
    return Number(r.lastInsertRowid);
  }

  // ── TRADES (the books) ────────────────────────────────────────────────────

  openTrade(t) {
    const r = this.db.prepare(`
      INSERT INTO trades (signal_id, symbol, side, qty, entry_px, entry_ts, fees, regime, status)
      VALUES (?,?,?,?,?,?,?,?,'open')
    `).run(t.signalId ?? null, t.symbol, t.side, t.qty, t.entryPx, t.entryTs,
           t.fees ?? 0, t.regime ?? null);
    return Number(r.lastInsertRowid);
  }

  closeTrade(tradeId, x) {
    this.db.prepare(`
      UPDATE trades SET exit_px=?, exit_ts=?, gross_pnl=?, fees=?, funding=?,
                        net_pnl=?, r_multiple=?, mae_r=?, mfe_r=?, exit_reason=?, status='closed'
      WHERE id = ?
    `).run(x.exitPx, x.exitTs, x.grossPnl ?? null, x.fees ?? 0, x.funding ?? 0,
           x.netPnl ?? null, x.rMultiple ?? null, x.maeR ?? null, x.mfeR ?? null,
           x.exitReason ?? null, tradeId);
  }

  openTradesList() {
    return this.db.prepare(`SELECT * FROM trades WHERE status = 'open'`).all();
  }

  closedTrades({ since = 0, limit = 1000 } = {}) {
    return this.db.prepare(
      `SELECT * FROM trades WHERE status='closed' AND exit_ts >= ? ORDER BY exit_ts DESC LIMIT ?`
    ).all(since, limit);
  }

  // ── SOURCES ───────────────────────────────────────────────────────────────

  upsertSource(kind, handle, label = null) {
    this.db.prepare(`
      INSERT INTO sources (kind, handle, label, first_seen, status, weight)
      VALUES (?,?,?,?, 'observing', 0)
      ON CONFLICT(kind, handle) DO NOTHING
    `).run(kind, handle, label, Date.now());
    return this.db.prepare(`SELECT * FROM sources WHERE kind = ? AND handle = ?`).get(kind, handle);
  }

  insertSourceCall(c) {
    const r = this.db.prepare(`
      INSERT INTO source_calls (source_id, ts, symbol, direction, horizon_h, raw_text,
                                price_at_call, resolve_at, resolved)
      VALUES (?,?,?,?,?,?,?,?,0)
    `).run(c.sourceId, c.ts, c.symbol, c.direction, c.horizonH,
           c.rawText ?? null, c.priceAtCall ?? null, c.resolveAt);
    return Number(r.lastInsertRowid);
  }

  pendingSourceCalls(now = Date.now()) {
    return this.db.prepare(
      `SELECT * FROM source_calls WHERE resolved = 0 AND resolve_at <= ? ORDER BY resolve_at`
    ).all(now);
  }

  resolveSourceCall(callId, outcome, returnPct) {
    this.db.prepare(
      `UPDATE source_calls SET resolved = 1, outcome = ?, return_pct = ? WHERE id = ?`
    ).run(outcome, returnPct, callId);
  }

  sourceCallTally(sourceId) {
    return this.db.prepare(`
      SELECT COUNT(*) AS n,
             SUM(CASE WHEN outcome = 'correct' THEN 1 ELSE 0 END) AS n_correct,
             AVG(return_pct) AS avg_return
      FROM source_calls WHERE source_id = ? AND resolved = 1
    `).get(sourceId);
  }

  allSources() {
    return this.db.prepare(`SELECT * FROM sources`).all();
  }

  saveSourceScore(s) {
    this.db.prepare(`
      INSERT INTO source_scores (source_id, n_resolved, n_correct, hit_rate, wilson_lb, avg_return, weight, updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(source_id) DO UPDATE SET
        n_resolved=excluded.n_resolved, n_correct=excluded.n_correct,
        hit_rate=excluded.hit_rate, wilson_lb=excluded.wilson_lb,
        avg_return=excluded.avg_return, weight=excluded.weight,
        updated_at=excluded.updated_at
    `).run(s.sourceId, s.nResolved, s.nCorrect, s.hitRate, s.wilsonLb,
           s.avgReturn ?? null, s.weight, Date.now());
    this.db.prepare(`UPDATE sources SET weight = ?, status = ? WHERE id = ?`)
      .run(s.weight, s.status ?? "observing", s.sourceId);
  }

  trustedSources(minWeight = 0.01) {
    return this.db.prepare(`
      SELECT s.*, sc.hit_rate, sc.wilson_lb, sc.n_resolved
      FROM sources s JOIN source_scores sc ON sc.source_id = s.id
      WHERE s.weight >= ? ORDER BY sc.wilson_lb DESC
    `).all(minWeight);
  }

  // ── RISK STATE ────────────────────────────────────────────────────────────

  setState(key, value) {
    this.db.prepare(`
      INSERT INTO risk_state (key, value, updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at
    `).run(key, JSON.stringify(value), Date.now());
  }

  getState(key, fallback = null) {
    const row = this.db.prepare(`SELECT value FROM risk_state WHERE key = ?`).get(key);
    if (!row) return fallback;
    try { return JSON.parse(row.value); } catch { return fallback; }
  }

  // ── CALIBRATION ───────────────────────────────────────────────────────────

  saveCalibration(bucket, regime, { n, nWin, realizedWr, avgR }) {
    this.db.prepare(`
      INSERT INTO calibration (bucket, regime, n, n_win, realized_wr, avg_r, updated_at)
      VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(bucket, regime) DO UPDATE SET
        n=excluded.n, n_win=excluded.n_win, realized_wr=excluded.realized_wr,
        avg_r=excluded.avg_r, updated_at=excluded.updated_at
    `).run(bucket, regime, n, nWin, realizedWr ?? null, avgR ?? null, Date.now());
  }

  getCalibration(bucket, regime) {
    return this.db.prepare(
      `SELECT * FROM calibration WHERE bucket = ? AND regime = ?`
    ).get(bucket, regime);
  }

  // ── AI SPEND ──────────────────────────────────────────────────────────────

  recordAiUsage(u) {
    this.db.prepare(`
      INSERT INTO ai_usage (ts, layer, model, in_tok, out_tok, cached_tok, cost_usd)
      VALUES (?,?,?,?,?,?,?)
    `).run(Date.now(), u.layer, u.model, u.inTok ?? 0, u.outTok ?? 0,
           u.cachedTok ?? 0, u.costUsd ?? 0);
  }

  aiSpendSince(since) {
    return this.db.prepare(
      `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE ts >= ?`
    ).get(since).total;
  }
}
