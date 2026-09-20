#!/usr/bin/env node
/**
 * Edge report — the only question that matters before funding anything.
 *
 * Reads closed trades from the store, measures expectancy with a confidence
 * interval, and reports what daily income that edge and equity actually
 * support. Refuses to quote an income figure off an unproven edge.
 *
 * Usage:
 *   node --env-file=.env src/edge.js
 *   node --env-file=.env src/edge.js --target 150 --equity 3000
 */

import { Store } from "./data/store.js";
import { computeExpectancy, formatExpectancy } from "./core/expectancy.js";
import { IncomePlan, formatAssessment } from "./core/income.js";
import { CostModel } from "./core/costs.js";

const args = process.argv.slice(2);
const arg = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const DB       = process.env.DB_PATH || "./data/trader.db";
const TARGET   = parseFloat(arg("--target", process.env.TARGET_DAILY_PHP || "0"));
const EQUITY   = parseFloat(arg("--equity", process.env.BALANCE || "50"));
const RISK_PCT = parseFloat(arg("--risk",   process.env.RISK_PCT || "2"));
const PHP_USD  = parseFloat(process.env.PHP_PER_USD || "57");
const MIN_NOTIONAL = parseFloat(process.env.MIN_NOTIONAL_USD || "5");

const store  = new Store(DB);
const trades = store.closedTrades({ limit: 5000 });

const costs = new CostModel({
  takerFeeBps: parseFloat(process.env.TAKER_FEE_BPS || "10"),
  makerFeeBps: parseFloat(process.env.MAKER_FEE_BPS || "10"),
  slippageBps: parseFloat(process.env.SLIPPAGE_BPS  || "5"),
  spreadBps:   parseFloat(process.env.SPREAD_BPS    || "0"),
});

console.log("\n" + "=".repeat(56));
console.log("  EDGE REPORT");
console.log("=".repeat(56));

const expectancy = computeExpectancy(trades);
console.log(formatExpectancy(expectancy));

// Tempo drives everything downstream — an edge you only get to express
// twice a month cannot fund anything, however good it is.
const tradesPerMonth = monthlyTempo(trades);
console.log(`  Tempo         : ~${tradesPerMonth} trades/month`);
console.log(`  Round trip    : ${costs.roundTripBps().toFixed(1)}bps charged per trade`);

if (TARGET > 0) {
  console.log("\n" + "-".repeat(56));
  console.log("  INCOME FEASIBILITY");
  console.log("-".repeat(56));

  const plan = new IncomePlan({ targetDailyPhp: TARGET, phpPerUsd: PHP_USD });
  console.log(formatAssessment(plan.assess({
    equity: EQUITY,
    expectancy,
    riskPctPerTrade: RISK_PCT,
    tradesPerMonth,
    minNotionalUsd: MIN_NOTIONAL,
  })));
}

console.log("=".repeat(56) + "\n");
store.close();

/** Observed trade frequency, normalised to a month. */
function monthlyTempo(rows) {
  const times = rows.map((t) => t.exit_ts).filter(Boolean).sort((a, b) => a - b);
  if (times.length < 2) return 0;
  const spanDays = (times.at(-1) - times[0]) / 86_400_000;
  if (spanDays < 1) return times.length;
  return Math.round((times.length / spanDays) * 30);
}
