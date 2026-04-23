#!/usr/bin/env node
/**
 * Watcher — Session-Based Multi-Asset Scanner
 *
 * Scans at peak trading sessions only (not every 15 min blindly).
 * Reads live MT5 balance so position sizing is always accurate.
 *
 * Session schedule (Philippines time, UTC+8):
 *   London Open      → 3:00 PM PH   (07:00 UTC)
 *   NY Open          → 9:30 PM PH   (13:30 UTC)  ← best for XAUUSD
 *   NY Close         → 4:00 AM PH   (20:00 UTC)
 *
 * Trade logic:
 *   - A+ signal  → send Telegram alert immediately (sure win candidate)
 *   - A  signal  → send Telegram alert
 *   - B or lower → skip (not worth the risk on a small account)
 *   - Max 3 trades open at once, stop trading if daily loss > 3%
 */

import { TraderBot }       from "./trader.js";
import { RiskEngine }      from "./utils/risk.js";
import { NewsFetcher }     from "./utils/news.js";
import { BrokerExecutor }  from "./utils/broker.js";
import { PositionMonitor } from "./utils/position_monitor.js";
import { ChartCapture }    from "./utils/chart_capture.js";
import { TradeGuard }      from "./utils/trade_guard.js";
import { startDashboard }  from "./dashboard.js";

// ── CONFIG ────────────────────────────────────────────────────────────────────

const assets      = (process.env.WATCH_ASSETS || "XAUUSD").split(",").map((a) => a.trim());
const minGrade    = process.env.MIN_GRADE    || "A";
const usingMT5    = (process.env.BROKER || "paper").toLowerCase() === "mt";
const maxDailyLoss = parseFloat(process.env.MAX_DAILY_LOSS_PCT || "3");
const defaultBalance = parseFloat(process.env.BALANCE || "50");
const riskPct     = parseFloat(process.env.RISK_PCT  || "2");
const bridgeUrl   = process.env.MT_BRIDGE_URL     || "http://127.0.0.1:15555";
const bridgeSecret = process.env.MT5_BRIDGE_SECRET || "";

const GRADES      = ["A+", "A", "B", "C", "skip"];
const minGradeIdx = GRADES.indexOf(minGrade);

// ── SESSION SCHEDULE (UTC) ────────────────────────────────────────────────────
// Each session = { name, utcHour, utcMinute, phTime (display only) }
const SESSIONS = [
  { name: "London Open",  utcHour: 7,  utcMinute: 0,  phTime: "3:00 PM"  },
  { name: "NY Open",      utcHour: 13, utcMinute: 30, phTime: "9:30 PM"  },
  { name: "NY Close",     utcHour: 20, utcMinute: 0,  phTime: "4:00 AM"  },
];

// ── INSTANCES ─────────────────────────────────────────────────────────────────

const bot          = new TraderBot();
const risk         = new RiskEngine();
const newsFetcher  = new NewsFetcher();
const broker       = new BrokerExecutor();
const chartCapture = new ChartCapture();
const monitor      = new PositionMonitor({ bridgeUrl, bridgeSecret });
const guard        = new TradeGuard({
  bridgeUrl,
  bridgeSecret,
  newsFetcher,
  config: {
    maxConsecutiveLosses: parseInt(process.env.MAX_CONSECUTIVE_LOSSES || "3", 10),
    lossCooldownHours:    parseFloat(process.env.LOSS_COOLDOWN_HOURS  || "6"),
    newsBlackoutMinutes:  parseInt(process.env.NEWS_BLACKOUT_MINUTES  || "30", 10),
    maxDailyLossPct:      maxDailyLoss,
  },
});

// ── LIVE BALANCE READER ───────────────────────────────────────────────────────

async function getLiveBalance() {
  if (!usingMT5) return defaultBalance;
  try {
    const headers = { "Content-Type": "application/json" };
    if (bridgeSecret) headers["X-Secret"] = bridgeSecret;
    const res  = await fetch(`${bridgeUrl}/account`, { headers });
    const data = await res.json();
    if (data.balance && data.balance > 0) {
      console.log(`[Balance] Live MT5 balance: $${data.balance.toFixed(2)}`);
      return data.balance;
    }
  } catch {
    // Bridge not running — fall back to .env value
  }
  console.log(`[Balance] Using .env balance: $${defaultBalance}`);
  return defaultBalance;
}

// ── HELPERS ───────────────────────────────────────────────────────────────────

function meetsThreshold(grade) {
  return GRADES.indexOf(grade) <= minGradeIdx;
}

function phTimeNow() {
  return new Date().toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit", minute: "2-digit", hour12: true,
  });
}

function msUntilUtc(hour, minute) {
  const now  = new Date();
  const next = new Date();
  next.setUTCHours(hour, minute, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next - now;
}

function fmtMs(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── SCAN ONE ASSET ────────────────────────────────────────────────────────────

async function scanAsset(asset, balance, sessionName) {
  console.log(`\n[Watch] Scanning ${asset}...`);

  // 1. Capture live TradingView charts
  let charts = {};
  try {
    charts = await chartCapture.captureAsset(asset);
  } catch (err) {
    console.warn(`[Charts] Failed: ${err.message}`);
    console.warn(`[Charts] Run "npx playwright install chromium" if not done yet`);
  }

  // 2. Fetch news sentiment
  let newsContext = "";
  try {
    const s = await newsFetcher.getSentiment(asset);
    newsContext = `${s.sentiment} (${s.strength}%) — ${s.key_drivers}`;
  } catch {}

  // 3. Run Claude analysis with live charts + balance
  const signal = await bot.analyze({
    asset,
    balance,
    riskPct,
    session: sessionName,
    news:    newsContext || "No specific news context.",
    charts,
  });

  const grade = signal.meta?.grade;
  const chartCount = Object.keys(charts).length;

  console.log(risk.formatReport(signal));
  console.log(`[Watch] Charts used: ${chartCount}/3 | Grade: ${grade} | Session: ${sessionName}`);

  // 4. Route signal
  if (!meetsThreshold(grade)) {
    console.log(`[Watch] ${asset} grade ${grade} — below threshold (${minGrade}), skipping.\n`);
    return null;
  }

  // Pre-trade safety checks
  if (usingMT5) {
    const check = await guard.check({ asset });
    if (!check.allow) {
      console.log(`[Watch] 🛑 Blocked: ${check.reason}`);
      return signal;
    }
  }

  const result = await broker.execute(signal);
  if (result.success) {
    console.log(`[Watch] ✅ Executed — ${asset} ${signal.verdict} @ ${signal.entry} | Order: ${result.orderId} | Risk: $${signal.meta.riskAmount}`);
  } else if (!result.skipped) {
    console.log(`[Watch] ❌ Execute failed: ${result.error}`);
  }

  return signal;
}

// ── SESSION SCAN (all assets) ─────────────────────────────────────────────────

async function runSession(sessionName) {
  const phNow = phTimeNow();
  console.log(`\n${"═".repeat(52)}`);
  console.log(`  📊 SESSION: ${sessionName}`);
  console.log(`  🕐 PH Time: ${phNow}`);
  console.log(`  💰 Assets:  ${assets.join(", ")}`);
  console.log(`${"═".repeat(52)}\n`);

  // Check daily loss limit before doing anything
  if (usingMT5) {
    const limitHit = await monitor.checkDailyLoss({ maxDailyLossPct: maxDailyLoss });
    if (limitHit) {
      console.log("[Watch] ⛔ Daily loss limit hit — no trades this session.\n");
      return;
    }
  }

  // Read live balance once for the whole session
  const balance = await getLiveBalance();
  const riskAmt = (balance * riskPct / 100).toFixed(2);
  console.log(`[Watch] Balance: $${balance.toFixed(2)} | Risk per trade: $${riskAmt} (${riskPct}%)\n`);

  // Scan each asset with a short gap between them
  for (const asset of assets) {
    try {
      await scanAsset(asset, balance, sessionName);
      if (assets.indexOf(asset) < assets.length - 1) {
        await new Promise((r) => setTimeout(r, 5000)); // 5s between assets
      }
    } catch (err) {
      console.error(`[Watch] ${asset} error:`, err.message);
    }
  }

  console.log(`\n[Watch] Session complete — ${sessionName}\n`);
}

// ── SESSION SCHEDULER ─────────────────────────────────────────────────────────

function scheduleSession(session) {
  const ms   = msUntilUtc(session.utcHour, session.utcMinute);
  const when = fmtMs(ms);

  console.log(`[Schedule] ${session.name.padEnd(14)} → ${session.phTime} PH  (in ${when})`);

  setTimeout(async () => {
    await runSession(session.name);
    scheduleSession(session); // reschedule for next day
  }, ms);
}

// ── STARTUP ───────────────────────────────────────────────────────────────────

console.log(`
╔══════════════════════════════════════════════════╗
║         AI TRADER — SESSION MODE                 ║
║         Optimized for Philippines (UTC+8)        ║
╚══════════════════════════════════════════════════╝

  Assets:      ${assets.join(", ")}
  Min grade:   ${minGrade} (A+ and A only → quality trades)
  Risk:        ${riskPct}% per trade
  Execute:     AUTO (fires immediately)
  Broker:      ${process.env.BROKER || "paper"}
  Charts:      Auto-capture from TradingView
  Daily limit: Stop trading at -${maxDailyLoss}% drawdown
`);

console.log("  Scheduled sessions:");
SESSIONS.forEach((s) => scheduleSession(s));

console.log(`
  Current PH time: ${phTimeNow()}
  Waiting for next session window...
`);

// Position monitor — every 60s, trails stops on open MT5 positions
if (usingMT5) {
  console.log("[Monitor] Trailing stop monitor active (every 60s)\n");
  setInterval(() => monitor.tick(), 60_000);
}

// Dashboard — web GUI with live logs + manual scan buttons
startDashboard({ assets, broker: process.env.BROKER || "paper", brokerExecutor: broker, scanAsset, getLiveBalance, bridgeUrl, bridgeSecret, guard });
