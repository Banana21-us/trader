#!/usr/bin/env node
/**
 * TradingView Webhook Server — with Telegram YES/NO execution buttons
 *
 * TradingView sends an alert → bot analyzes → Telegram sends signal
 * with [✅ EXECUTE] [❌ SKIP] buttons → you tap → broker fires (or not)
 *
 * Setup in TradingView alert:
 *   Webhook URL: http://YOUR_IP:3001/webhook  (use ngrok for local)
 *   Message (JSON):
 *   {
 *     "asset":     "{{ticker}}",
 *     "price":     {{close}},
 *     "timeframe": "{{interval}}",
 *     "signal":    "buy",
 *     "news":      "optional context",
 *     "secret":    "your_webhook_secret"
 *   }
 *
 * Run:    node src/webhook.js
 * Expose: ngrok http 3001
 */

import http from "http";
import { TraderBot }       from "./trader.js";
import { RiskEngine }      from "./utils/risk.js";
import { TelegramAlerter } from "./utils/telegram.js";
import { BrokerExecutor }  from "./utils/broker.js";
import { NewsFetcher }     from "./utils/news.js";

const PORT         = process.env.WEBHOOK_PORT || 3001;
const SECRET       = process.env.WEBHOOK_SECRET || null;
const autoExecute  = process.env.AUTO_EXECUTE === "true";

const bot      = new TraderBot();
const risk     = new RiskEngine();
const telegram = new TelegramAlerter();
const broker   = new BrokerExecutor();
const newsFetcher = new NewsFetcher();

// ─── EXECUTION CALLBACKS ──────────────────────────────────────────────────────

async function executeSignal(signal) {
  return await broker.execute(signal);
}

function skipSignal(signal) {
  console.log(`[Webhook] Skipped: ${signal.meta?.asset} ${signal.verdict}`);
}

// ─── PROCESS INCOMING ALERT ───────────────────────────────────────────────────

async function processAlert(payload) {
  const { asset, timeframe, signal: tvSignal, news: tvNews } = payload;

  console.log(`\n[Webhook] Alert received — ${asset} ${timeframe} (${tvSignal || "?"})`);
  await telegram.sendText(`📡 *TradingView alert* — ${asset} | ${timeframe} | ${(tvSignal || "??").toUpperCase()}\n_Analyzing..._`);

  // Auto-fetch news sentiment
  let newsContext = tvNews || "";
  try {
    const sentiment = await newsFetcher.getSentiment(asset);
    newsContext += ` | ${sentiment.sentiment} (${sentiment.strength}%) — ${sentiment.key_drivers}`;
  } catch {}

  const signal = await bot.analyze({ asset, news: newsContext });
  const grade  = signal.meta?.grade;

  console.log(risk.formatReport(signal));

  if (autoExecute) {
    // No buttons — fire immediately
    await telegram.sendSignal(signal);
    const result = await broker.execute(signal);
    if (result?.success) {
      await telegram.sendText(`✅ Auto-executed: ${asset} ${signal.verdict} @ ${signal.entry}`);
    } else if (!result?.skipped) {
      await telegram.sendText(`❌ Auto-execute failed: ${result?.error}`);
    }
  } else if (["A+", "A", "B"].includes(grade)) {
    // Send with YES/NO buttons
    await telegram.sendSignal(signal, {
      onExecute: executeSignal,
      onSkip:    skipSignal,
    });
  } else {
    await telegram.sendText(`⚪ ${asset} signal grade *${grade}* — below alert threshold, skipped.`);
  }
}

// ─── HTTP SERVER ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // Health check
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", time: new Date().toISOString() }));
    return;
  }

  if (req.method !== "POST" || req.url !== "/webhook") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", async () => {
    try {
      const payload = JSON.parse(body);

      // Validate secret
      if (SECRET && payload.secret !== SECRET) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }

      // Respond to TradingView immediately (it times out after 3s)
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ received: true }));

      // Process async
      processAlert(payload).catch((err) => {
        console.error("[Webhook] processAlert error:", err.message);
        telegram.sendText(`❌ Webhook processing error: ${err.message}`).catch(() => {});
      });
    } catch (err) {
      console.error("[Webhook] Parse error:", err.message);
      res.writeHead(400);
      res.end("Bad request");
    }
  });
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║     AI TRADER — WEBHOOK SERVER           ║
╚══════════════════════════════════════════╝

  Listening:  http://localhost:${PORT}/webhook
  Health:     http://localhost:${PORT}/health
  Execute:    ${autoExecute ? "AUTO (no confirmation)" : "MANUAL (YES/NO buttons on Telegram)"}
  Broker:     ${process.env.BROKER || "paper"}
  Telegram:   ${process.env.TELEGRAM_BOT_TOKEN ? "enabled" : "disabled"}

  Expose with: ngrok http ${PORT}
`);
});

// Start Telegram callback listener for button taps
telegram.startCallbackListener();
