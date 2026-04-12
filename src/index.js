#!/usr/bin/env node
import { TraderBot } from "./trader.js";
import { RiskEngine } from "./utils/risk.js";
import readline from "readline";
import path from "path";
import fs from "fs";

const bot = new TraderBot({
  defaultAsset: process.env.ASSET || "XAUUSD",
  defaultBalance: parseFloat(process.env.BALANCE || "1000"),
  defaultRiskPct: parseFloat(process.env.RISK_PCT || "2"),
  minConfidence: 65,
  minRR: 2.0,
});

const riskEngine = new RiskEngine();

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--asset":    opts.asset = args[++i]; break;
      case "--balance":  opts.balance = parseFloat(args[++i]); break;
      case "--risk":     opts.riskPct = parseFloat(args[++i]); break;
      case "--session":  opts.session = args[++i]; break;
      case "--news":     opts.news = args[++i]; break;
      case "--daily":    opts.charts = { ...(opts.charts||{}), daily: args[++i] }; break;
      case "--m15":      opts.charts = { ...(opts.charts||{}), m15: args[++i] }; break;
      case "--m5":       opts.charts = { ...(opts.charts||{}), m5: args[++i] }; break;
      case "--help":     printHelp(); process.exit(0);
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
AI Trader Bot — Claude-powered multi-model trade analyzer

Usage:
  node src/index.js [options]

Options:
  --asset    <symbol>   Asset to trade (default: XAUUSD)
  --balance  <number>   Account balance in USD (default: 1000)
  --risk     <number>   Risk % per trade (default: 2)
  --session  <string>   Trading session
  --news     <string>   News / macro context
  --daily    <path>     Path to daily chart screenshot
  --m15      <path>     Path to 15-minute chart screenshot
  --m5       <path>     Path to 5-minute chart screenshot
  --help                Show this help

Examples:
  # Quick analysis without charts
  node src/index.js --asset XAUUSD --balance 5000 --risk 2

  # Full 3-timeframe analysis with screenshots
  node src/index.js \\
    --asset XAUUSD \\
    --balance 5000 \\
    --risk 2 \\
    --news "Fed meeting tomorrow, dollar strengthening" \\
    --daily ./screenshots/xau-daily.png \\
    --m15  ./screenshots/xau-15m.png \\
    --m5   ./screenshots/xau-5m.png

Environment variables:
  ANTHROPIC_API_KEY    Your Anthropic API key (required)
  ASSET                Default asset
  BALANCE              Default balance
  RISK_PCT             Default risk %
`);
}

async function promptUser(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (ans) => { rl.close(); resolve(ans.trim()); }));
}

async function interactiveMode() {
  console.log("\n╔══════════════════════════════╗");
  console.log("║      AI TRADER BOT v1.0      ║");
  console.log("║   Powered by Claude claude-opus-4-5   ║");
  console.log("╚══════════════════════════════╝\n");

  const asset   = await promptUser("Asset (e.g. XAUUSD, BTCUSDT, EURUSD) [XAUUSD]: ") || "XAUUSD";
  const balance = parseFloat(await promptUser("Account balance [$1000]: ") || "1000");
  const riskPct = parseFloat(await promptUser("Risk % per trade [2]: ") || "2");
  const news    = await promptUser("News/macro context (or press Enter to skip): ");

  const dailyPath = await promptUser("Daily chart path (or Enter to skip): ");
  const m15Path   = await promptUser("15min chart path (or Enter to skip): ");
  const m5Path    = await promptUser("5min chart path (or Enter to skip): ");

  const charts = {};
  if (dailyPath && fs.existsSync(dailyPath)) charts.daily = path.resolve(dailyPath);
  if (m15Path   && fs.existsSync(m15Path))   charts.m15   = path.resolve(m15Path);
  if (m5Path    && fs.existsSync(m5Path))    charts.m5    = path.resolve(m5Path);

  const chartCount = Object.keys(charts).length;
  console.log(`\nAnalyzing ${asset} with ${chartCount} chart(s)...\n`);

  return { asset, balance, riskPct, news: news || undefined, charts };
}

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("Error: ANTHROPIC_API_KEY environment variable is required.");
    process.exit(1);
  }

  let params;

  if (process.argv.length <= 2) {
    params = await interactiveMode();
  } else {
    params = parseArgs();
  }

  try {
    const signal = await bot.analyze(params);
    console.log(riskEngine.formatReport(signal));

    if (!bot.isTradeworthy(signal)) {
      console.log("⚠  Signal below quality threshold — consider skipping this trade.\n");
    }

  } catch (err) {
    console.error("\nAnalysis failed:", err.message);
    process.exit(1);
  }
}

main();
