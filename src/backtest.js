#!/usr/bin/env node
/**
 * Backtest Harness
 *
 * Replays historical MT5 candles through the AI signal engine and measures
 * real expectancy — the only honest way to know if the bot has an edge.
 *
 * Requirements: MT5 bridge running  (python mt5_bridge/server.py)
 * Model used:   Claude Haiku (cheap ~$0.001/scan — full 30-day run ≈ $0.50)
 *
 * Usage:
 *   node --env-file=.env src/backtest.js
 *   node --env-file=.env src/backtest.js --asset EURUSD --days 60
 *   node --env-file=.env src/backtest.js --asset XAUUSD --days 30 --balance 1000
 */

import Anthropic from "@anthropic-ai/sdk";
import fs        from "fs";
import path      from "path";
import { buildTraderSystemPrompt } from "./prompts/system.js";
import { RiskEngine }              from "./utils/risk.js";

// ── CLI args ──────────────────────────────────────────────────────────────────

const args   = process.argv.slice(2);
const getArg = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

const ASSET          = getArg("--asset",   process.env.BACKTEST_ASSET  || "XAUUSD");
const DAYS           = parseInt(getArg("--days",    "30"), 10);
const BALANCE        = parseFloat(getArg("--balance", process.env.BALANCE  || "1000"));
const RISK_PCT       = parseFloat(getArg("--riskPct", process.env.RISK_PCT || "2"));
const MIN_GRADE      = getArg("--grade",   "A");
const SCAN_EVERY     = 4;      // scan every N M15 candles (= every 1 hour)
const MAX_HOLD_BARS  = 192;    // max 48 hours before force-closing
const BRIDGE_URL     = process.env.MT_BRIDGE_URL      || "http://127.0.0.1:15555";
const BRIDGE_SECRET  = process.env.MT5_BRIDGE_SECRET  || "";

const GRADE_ORDER = ["A+", "A", "B", "C", "skip"];

const client     = new Anthropic();
const riskEngine = new RiskEngine();

// ── Bridge helpers ────────────────────────────────────────────────────────────

async function fetchCandles(symbol, tf, count) {
  const headers = { "Content-Type": "application/json" };
  if (BRIDGE_SECRET) headers["X-Secret"] = BRIDGE_SECRET;
  const res  = await fetch(`${BRIDGE_URL}/candles/${symbol}?tf=${tf}&count=${count}`, { headers });
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(data.error || `Cannot fetch ${tf} candles for ${symbol}`);
  return data;
}

// ── Indicators ────────────────────────────────────────────────────────────────

function ema(candles, period) {
  const k = 2 / (period + 1);
  let e = candles[0].c;
  for (let i = 1; i < candles.length; i++) e = candles[i].c * k + e * (1 - k);
  return parseFloat(e.toFixed(5));
}

function rsi(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const d = candles[i].c - candles[i - 1].c;
    if (d > 0) gains  += d;
    else        losses -= d;
  }
  const rs = losses === 0 ? 100 : gains / losses;
  return parseFloat((100 - 100 / (1 + rs)).toFixed(1));
}

function atr(candles, period = 14) {
  if (candles.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c),
    ));
  }
  const relevant = trs.slice(-period);
  return parseFloat((relevant.reduce((s, x) => s + x, 0) / relevant.length).toFixed(5));
}

function detectSession(utcHour) {
  if (utcHour >= 7  && utcHour < 10) return "London open";
  if (utcHour >= 12 && utcHour < 17) return "London-NY overlap";
  if (utcHour >= 13 && utcHour < 16) return "New York open";
  if (utcHour >= 22 || utcHour < 7)  return "Asian session";
  return "Off-hours";
}

// ── Prompt builder ────────────────────────────────────────────────────────────

function fmtCandle(c) {
  const d = new Date(c.t * 1000).toISOString().slice(0, 16).replace("T", " ");
  return `${d}  O:${c.o.toFixed(5)}  H:${c.h.toFixed(5)}  L:${c.l.toFixed(5)}  C:${c.c.toFixed(5)}`;
}

function buildBacktestPrompt({ asset, session, balance, riskPct, d1, h1, m15 }) {
  const indM15 = {
    ema20: ema(m15.slice(-60), 20),
    ema50: ema(m15.slice(-80), 50),
    rsi14: rsi(m15.slice(-30), 14),
    atr14: atr(m15.slice(-20), 14),
  };
  const indH1 = {
    ema20: ema(h1.slice(-40), 20),
    ema50: ema(h1.slice(-60), 50),
  };

  const now = new Date(m15[m15.length - 1].t * 1000);

  return `You are analyzing historical price data for ${asset}.
Asset: ${asset} | Session: ${session} | Time: ${now.toISOString().slice(0, 16)} UTC
Account balance: $${balance} | Risk per trade: ${riskPct}%

=== DAILY CHART (last ${d1.length} bars — HTF bias) ===
${d1.map(fmtCandle).join("\n")}

=== H1 CHART (last ${h1.length} bars — structure) ===
${h1.map(fmtCandle).join("\n")}

=== M15 CHART (last ${m15.length} bars — entry setup) ===
${m15.map(fmtCandle).join("\n")}

=== INDICATORS (M15) ===
EMA20: ${indM15.ema20}  EMA50: ${indM15.ema50}  RSI14: ${indM15.rsi14}  ATR14: ${indM15.atr14}

=== INDICATORS (H1) ===
EMA20: ${indH1.ema20}  EMA50: ${indH1.ema50}

Analyze price action using SMC concepts (order blocks, FVG, liquidity, structure).
Use ALL the candle data provided as your chart — treat D1 as daily chart, H1 as hourly, M15 as entry chart.
Output ONLY valid JSON matching the standard signal format. No markdown.`;
}

// ── AI analysis ───────────────────────────────────────────────────────────────

async function analyzeWithHaiku(prompt) {
  const res = await client.messages.create({
    model:      "claude-haiku-4-5-20251001",
    max_tokens: 1200,
    system:     buildTraderSystemPrompt(),
    messages:   [{ role: "user", content: prompt }],
  });

  const raw = res.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ── Trade simulation ──────────────────────────────────────────────────────────

function parsePrice(str) {
  if (!str) return null;
  const m = String(str).match(/[\d.]+/);
  return m ? parseFloat(m[0]) : null;
}

function simulateTrade(signal, futureCandles) {
  const entry = parsePrice(signal.entry);
  const sl    = parsePrice(signal.stop_loss);
  const tp    = parsePrice(signal.take_profit);

  if (!entry || !sl || !tp) return null;

  const isBuy  = signal.verdict === "BUY";
  const riskPts = Math.abs(entry - sl);
  if (riskPts === 0) return null;

  for (let i = 0; i < Math.min(futureCandles.length, MAX_HOLD_BARS); i++) {
    const bar = futureCandles[i];

    if (isBuy) {
      if (bar.l <= sl) return { outcome: "loss", bars: i + 1, exitPrice: sl };
      if (bar.h >= tp) return { outcome: "win",  bars: i + 1, exitPrice: tp };
    } else {
      if (bar.h >= sl) return { outcome: "loss", bars: i + 1, exitPrice: sl };
      if (bar.l <= tp) return { outcome: "win",  bars: i + 1, exitPrice: tp };
    }
  }

  // Force close at last bar
  const exitPrice = futureCandles[Math.min(futureCandles.length - 1, MAX_HOLD_BARS - 1)]?.c || entry;
  const pnlPts    = isBuy ? exitPrice - entry : entry - exitPrice;
  return { outcome: pnlPts >= 0 ? "win" : "loss", bars: MAX_HOLD_BARS, exitPrice, expired: true };
}

// ── Stats ─────────────────────────────────────────────────────────────────────

function computeStats(trades, balance, riskPct) {
  const riskAmt = balance * (riskPct / 100);
  const wins    = trades.filter((t) => t.outcome === "win");
  const losses  = trades.filter((t) => t.outcome === "loss");

  const totalPnL  = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin    = wins.length   ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length     : 0;
  const avgLoss   = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const winRate   = trades.length ? (wins.length / trades.length) * 100 : 0;
  const expectancy = (winRate / 100) * avgWin + (1 - winRate / 100) * avgLoss;

  // Max drawdown
  let equity = balance, peak = balance, maxDD = 0;
  for (const t of trades) {
    equity += t.pnl;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return {
    totalTrades: trades.length,
    wins:        wins.length,
    losses:      losses.length,
    winRate:     parseFloat(winRate.toFixed(1)),
    totalPnL:    parseFloat(totalPnL.toFixed(2)),
    avgWin:      parseFloat(avgWin.toFixed(2)),
    avgLoss:     parseFloat(avgLoss.toFixed(2)),
    expectancy:  parseFloat(expectancy.toFixed(2)),
    maxDrawdown: parseFloat(maxDD.toFixed(1)),
    finalBalance: parseFloat((balance + totalPnL).toFixed(2)),
    byGrade: Object.fromEntries(
      ["A+", "A", "B"].map((g) => {
        const gt = trades.filter((t) => t.grade === g);
        const gw = gt.filter((t) => t.outcome === "win");
        return [g, { trades: gt.length, winRate: gt.length ? ((gw.length / gt.length) * 100).toFixed(1) + "%" : "—" }];
      })
    ),
  };
}

function printReport(stats, trades, asset, days) {
  const bar = (pct) => "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
  const sign = (n) => (n >= 0 ? "+" : "") + n;

  console.log(`
╔══════════════════════════════════════════════════════╗
║          BACKTEST RESULTS — ${asset.padEnd(6)} (${days}d)          ║
╚══════════════════════════════════════════════════════╝

  Total trades  : ${stats.totalTrades}
  Wins / Losses : ${stats.wins} / ${stats.losses}
  Win Rate      : ${stats.winRate}%  ${bar(stats.winRate)}

  Avg Win       : $${sign(stats.avgWin)}
  Avg Loss      : $${sign(stats.avgLoss)}
  Expectancy    : $${sign(stats.expectancy)} per trade  ${stats.expectancy > 0 ? "✅ POSITIVE EDGE" : "❌ NO EDGE"}

  Total P&L     : $${sign(stats.totalPnL)}
  Final Balance : $${stats.finalBalance}
  Max Drawdown  : ${stats.maxDrawdown}%

  By grade:
    A+: ${stats.byGrade["A+"].trades} trades  ${stats.byGrade["A+"].winRate} win
    A : ${stats.byGrade["A"].trades} trades  ${stats.byGrade["A"].winRate} win
    B : ${stats.byGrade["B"].trades} trades  ${stats.byGrade["B"].winRate} win

${"═".repeat(54)}
`);

  // Show last 20 trades
  if (trades.length > 0) {
    console.log("  Recent trades (newest last):");
    trades.slice(-20).forEach((t) => {
      const icon = t.outcome === "win" ? "✅" : "❌";
      console.log(`    ${icon} [${t.grade}] ${t.verdict} @ ${t.entry?.toFixed(5) || "?"} → ${sign(t.pnl.toFixed(2))} (${t.bars}bars${t.expired ? " EXPIRED" : ""})`);
    });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n[Backtest] ${ASSET} | ${DAYS} days | $${BALANCE} @ ${RISK_PCT}% risk | Min grade: ${MIN_GRADE}`);
  console.log(`[Backtest] Estimated API cost (Haiku): ~$${(DAYS * 24 * 0.001).toFixed(2)}\n`);

  // Fetch candles
  const m15Count = DAYS * 24 * 4 + 100;
  const h1Count  = DAYS * 24 + 50;
  const d1Count  = DAYS + 30;

  console.log(`[Backtest] Fetching candles from MT5 bridge...`);
  let m15All, h1All, d1All;
  try {
    [m15All, h1All, d1All] = await Promise.all([
      fetchCandles(ASSET, "M15", m15Count),
      fetchCandles(ASSET, "H1",  h1Count),
      fetchCandles(ASSET, "D1",  d1Count),
    ]);
  } catch (err) {
    console.error(`[Backtest] ❌ Cannot fetch candles: ${err.message}`);
    console.error(`           Make sure the MT5 bridge is running: python mt5_bridge/server.py`);
    process.exit(1);
  }

  console.log(`[Backtest] Got ${m15All.length} M15 | ${h1All.length} H1 | ${d1All.length} D1 candles`);

  // Scan points: every SCAN_EVERY M15 candles, skip first 100 (need indicator warmup)
  const scanPoints = [];
  for (let i = 100; i < m15All.length - MAX_HOLD_BARS; i += SCAN_EVERY) {
    scanPoints.push(i);
  }

  console.log(`[Backtest] Scanning ${scanPoints.length} points (every ${SCAN_EVERY} M15 bars)...\n`);

  const trades    = [];
  const skipped   = [];
  const riskAmt   = BALANCE * (RISK_PCT / 100);
  const minGradeIdx = GRADE_ORDER.indexOf(MIN_GRADE);

  for (let idx = 0; idx < scanPoints.length; idx++) {
    const i      = scanPoints[idx];
    const candle = m15All[i];
    const hour   = new Date(candle.t * 1000).getUTCHours();
    const session = detectSession(hour);

    // Skip weekends (UTC Saturday=6, Sunday=0)
    const day = new Date(candle.t * 1000).getUTCDay();
    if (day === 0 || day === 6) continue;

    // Skip off-hours for efficiency (optional — remove to backtest all hours)
    if (session === "Off-hours" || session === "Asian session") continue;

    // Build context windows
    const m15Window = m15All.slice(Math.max(0, i - 60), i + 1);
    const h1Idx     = h1All.findIndex((c) => c.t >= candle.t);
    const h1Window  = h1All.slice(Math.max(0, (h1Idx >= 0 ? h1Idx : h1All.length) - 24), h1Idx >= 0 ? h1Idx + 1 : h1All.length);
    const d1Idx     = d1All.findIndex((c) => c.t >= candle.t);
    const d1Window  = d1All.slice(Math.max(0, (d1Idx >= 0 ? d1Idx : d1All.length) - 10), d1Idx >= 0 ? d1Idx + 1 : d1All.length);

    const pct = ((idx + 1) / scanPoints.length * 100).toFixed(0);
    process.stdout.write(`\r[Backtest] Progress: ${pct}% (${idx + 1}/${scanPoints.length}) | Trades: ${trades.length}`);

    let signal;
    try {
      const prompt = buildBacktestPrompt({
        asset: ASSET, session, balance: BALANCE, riskPct: RISK_PCT,
        d1: d1Window, h1: h1Window, m15: m15Window,
      });
      signal = await analyzeWithHaiku(prompt);
    } catch {
      skipped.push({ reason: "parse error", idx: i });
      await new Promise((r) => setTimeout(r, 1000)); // brief pause on error
      continue;
    }

    // Grade check
    const grade = riskEngine.gradeSignal(signal);
    if (GRADE_ORDER.indexOf(grade) > minGradeIdx) continue;

    // Sanity / isTradeworthy check
    const enriched = riskEngine.enrich(signal, { balance: BALANCE, riskPct: RISK_PCT, asset: ASSET });
    if (!enriched.meta.isTradeworthy) {
      skipped.push({ reason: "not tradworthy", grade, idx: i });
      continue;
    }

    // Simulate on future candles
    const futureCandles = m15All.slice(i + 1, i + 1 + MAX_HOLD_BARS);
    const sim = simulateTrade(signal, futureCandles);
    if (!sim) {
      skipped.push({ reason: "invalid levels", grade, idx: i });
      continue;
    }

    // Calculate dollar P&L based on actual R hit
    const entry     = parsePrice(signal.entry);
    const sl        = parsePrice(signal.stop_loss);
    const tp        = parsePrice(signal.take_profit);
    const riskPts   = Math.abs(entry - sl);
    const rewardPts = Math.abs(tp - entry);
    const actualPts = Math.abs(sim.exitPrice - entry);
    const rrActual  = riskPts > 0 ? (actualPts / riskPts) : 0;
    const pnl       = sim.outcome === "win"
      ? riskAmt * (rewardPts / riskPts)
      : -riskAmt;

    trades.push({
      idx,
      date:    new Date(candle.t * 1000).toISOString().slice(0, 16),
      grade,
      verdict: signal.verdict,
      entry,
      sl,
      tp,
      outcome:    sim.outcome,
      bars:       sim.bars,
      expired:    sim.expired || false,
      exitPrice:  sim.exitPrice,
      pnl:        parseFloat(pnl.toFixed(2)),
      rrActual:   parseFloat(rrActual.toFixed(2)),
      confidence: signal.confidence || 0,
    });

    // Rate limit: ~1 call per second on Haiku
    await new Promise((r) => setTimeout(r, 500));
  }

  process.stdout.write("\n\n");

  if (trades.length === 0) {
    console.log("[Backtest] No trades taken. Try lowering MIN_GRADE to B, or check your symbol name.");
    return;
  }

  const stats = computeStats(trades, BALANCE, RISK_PCT);
  printReport(stats, trades, ASSET, DAYS);

  // Save results
  const outDir  = path.join(process.cwd(), "logs");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const stamp   = new Date().toISOString().slice(0, 10);
  const outFile = path.join(outDir, `backtest_${ASSET}_${DAYS}d_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ stats, trades, skipped, meta: { asset: ASSET, days: DAYS, balance: BALANCE, riskPct: RISK_PCT, minGrade: MIN_GRADE, ranAt: new Date().toISOString() } }, null, 2));
  console.log(`[Backtest] Results saved → ${outFile}\n`);
}

main().catch((err) => {
  console.error("[Backtest] Fatal:", err.message);
  process.exit(1);
});
