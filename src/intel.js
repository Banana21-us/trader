#!/usr/bin/env node
/**
 * Intel cycle — gather, triage, record, resolve, score.
 *
 * Run this on a schedule. It does four things and opens zero trades:
 *   1. pulls free headlines (no API key needed for any feed)
 *   2. asks Gemini for vetoes and directional calls
 *   3. records the calls with a resolve time
 *   4. resolves calls whose horizon elapsed, and rescores every source
 *
 * The value is entirely in step 4. Until sources have a track record, the
 * honest weight for all of them is zero, and this command exists to build
 * that record rather than to act on it.
 *
 * Usage:
 *   node --env-file=.env src/intel.js
 *   node --env-file=.env src/intel.js --symbols BTCUSDT,ETHUSDT
 *   node --env-file=.env src/intel.js --scores-only
 */

import { Store }           from "./data/store.js";
import { BinanceRest }     from "./data/binance/rest.js";
import { IntelFeeds }      from "./intel/feeds.js";
import { GeminiIntel, activeVetoes } from "./intel/gemini.js";
import { SourceScorer, formatScores } from "./intel/scorer.js";

const args = process.argv.slice(2);
const arg  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const has  = (f) => args.includes(f);

const SYMBOLS = arg("--symbols", process.env.UNIVERSE || "BTCUSDT,ETHUSDT")
  .split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);

const store   = new Store(process.env.DB_PATH || "./data/trader.db");
const binance = new BinanceRest({ market: "spot" });
const scorer  = new SourceScorer(store, {
  minResolvedCalls:    parseInt(process.env.SOURCE_MIN_CALLS  || "30", 10),
  minWilsonLowerBound: parseFloat(process.env.SOURCE_MIN_WILSON || "0.5"),
});

console.log("\n" + "=".repeat(60));
console.log("  INTEL CYCLE");
console.log("=".repeat(60));

if (!has("--scores-only")) {
  const feeds = new IntelFeeds({ cryptoPanicKey: process.env.CRYPTOPANIC_KEY || "" });
  const gem   = new GeminiIntel();

  const headlines = await feeds.headlines();
  const fng       = await feeds.fearGreed(14).catch(() => null);
  console.log(`\n  Headlines     : ${headlines.length} from ${countSources(headlines)} sources`);
  if (fng) console.log(`  Fear & Greed  : ${fng.current} (${fng.label})${fng.extreme ? "  << " + fng.extreme : ""}`);

  if (!gem.enabled) {
    console.log("  Gemini        : disabled (no GEMINI_API_KEY) — skipping triage");
  } else {
    const t = await gem.triage(headlines, { symbols: SYMBOLS });
    if (!t.available) {
      console.log(`  Gemini        : FAILED — ${t.error?.slice(0, 120)}`);
    } else {
      console.log(`  Gemini        : ${gem.modelName}  (noise ~${t.noise_ratio}%)`);
      console.log(`  Narrative     : ${t.regime_note}`);

      const blocking = activeVetoes(t, { minSeverity: "high" });
      console.log(`\n  VETOES        : ${t.vetoes.length} (${blocking.length} high severity)`);
      for (const v of t.vetoes) console.log(`    [${v.severity}] ${v.reason} (${v.expires_hours}h)`);
      if (blocking.length) {
        store.setState("intel_veto", {
          until: Date.now() + Math.max(...blocking.map((v) => (v.expires_hours || 1))) * 3_600_000,
          reasons: blocking.map((v) => v.reason),
        });
        console.log("    -> veto persisted to risk_state; guards should read this before entry");
      }

      // Calls are recorded, never acted on.
      const prices = {};
      for (const s of SYMBOLS) {
        prices[s] = await binance.klines(s, "1m", { limit: 1 })
          .then((k) => k.at(-1)?.close).catch(() => null);
      }
      const n = gem.recordCalls(store, t, { priceLookup: (s) => prices[s] ?? null });
      console.log(`\n  CALLS         : ${t.calls.length} produced, ${n} recorded for scoring`);
      for (const c of t.calls) {
        console.log(`    ${c.symbol.padEnd(9)} ${c.direction.padEnd(5)} conv=${String(c.conviction).padStart(3)} ${c.horizon_hours}h`);
      }
      if (t.calls.length) console.log("    -> none of these open a trade. They are predictions on trial.");
    }
  }
}

// ── RESOLVE + SCORE ─────────────────────────────────────────────────────────

const res = await scorer.resolveDue(priceAt);
console.log(`\n  RESOLVED      : ${res.resolved} calls matured` +
            (res.skipped ? `, ${res.skipped} skipped (no price)` : ""));

console.log("\n" + "-".repeat(60));
console.log("  SOURCE TRACK RECORDS");
console.log("-".repeat(60));
console.log(formatScores(scorer.rescoreAll(), { minResolvedCalls: scorer.minResolvedCalls }));
console.log("=".repeat(60) + "\n");

store.close();

/** Close price of the 1m candle covering `ts`. */
async function priceAt(symbol, ts) {
  try {
    const k = await binance.klines(symbol, "1m", { startTime: ts, limit: 1 });
    return k[0]?.close ?? null;
  } catch { return null; }
}

function countSources(rows) {
  return new Set(rows.map((r) => r.source)).size;
}
