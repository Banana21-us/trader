#!/usr/bin/env node
/**
 * Trade Journal CLI
 * Usage:
 *   node src/journal.js              — view recent signals
 *   node src/journal.js --win ID     — mark trade as win
 *   node src/journal.js --loss ID    — mark trade as loss
 *   node src/journal.js --stats      — show performance stats
 *   node src/journal.js --grade A+   — filter by grade
 */

import fs from "fs";
import path from "path";
import { Logger } from "./utils/logger.js";

const logger = new Logger();
const args = process.argv.slice(2);

function getArg(flag) {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function loadAllSignals() {
  return logger.getSignalHistory(90);
}

function saveOutcome(signalId, outcome) {
  const files = fs.readdirSync("./logs").filter((f) => f.endsWith(".jsonl"));
  let updated = false;

  for (const file of files) {
    const filePath = path.join("./logs", file);
    const lines = fs.readFileSync(filePath, "utf8").trim().split("\n");
    const newLines = lines.map((line) => {
      try {
        const sig = JSON.parse(line);
        if (sig.meta?.timestamp?.includes(signalId) || line.includes(signalId)) {
          sig.outcome = outcome;
          sig.outcome_at = new Date().toISOString();
          updated = true;
          return JSON.stringify(sig);
        }
      } catch {}
      return line;
    });

    if (updated) {
      fs.writeFileSync(filePath, newLines.join("\n") + "\n");
      break;
    }
  }

  return updated;
}

function printStats(signals) {
  const total = signals.length;
  const withOutcome = signals.filter((s) => s.outcome);
  const wins = withOutcome.filter((s) => s.outcome === "win");
  const losses = withOutcome.filter((s) => s.outcome === "loss");
  const winRate = withOutcome.length ? ((wins.length / withOutcome.length) * 100).toFixed(1) : "N/A";

  const byGrade = {};
  for (const s of withOutcome) {
    const g = s.meta?.grade || "?";
    if (!byGrade[g]) byGrade[g] = { wins: 0, losses: 0 };
    if (s.outcome === "win") byGrade[g].wins++;
    else byGrade[g].losses++;
  }

  const totalRisk = withOutcome.reduce((sum, s) => sum + (s.meta?.riskAmount || 0), 0);
  const totalPnl = wins.reduce((sum, s) => sum + (s.meta?.maxReward || 0), 0)
                 - losses.reduce((sum, s) => sum + (s.meta?.riskAmount || 0), 0);

  console.log(`
╔══════════════════════════════════════════╗
║          TRADE JOURNAL STATS             ║
╚══════════════════════════════════════════╝

  Total signals:   ${total}
  With outcomes:   ${withOutcome.length}
  Wins:            ${wins.length}
  Losses:          ${losses.length}
  Win rate:        ${winRate}%
  Est. P&L:        $${totalPnl.toFixed(2)}
  Total risked:    $${totalRisk.toFixed(2)}

─── WIN RATE BY GRADE ──────────────────────`);

  for (const [grade, data] of Object.entries(byGrade).sort()) {
    const total2 = data.wins + data.losses;
    const wr = total2 ? ((data.wins / total2) * 100).toFixed(0) : 0;
    const bar = "█".repeat(Math.round(wr / 10)).padEnd(10, "░");
    console.log(`  [${grade}] ${bar} ${wr}% (${data.wins}W / ${data.losses}L)`);
  }

  console.log();
}

function printSignals(signals, limit = 20) {
  const recent = signals.slice(-limit).reverse();

  console.log(`\n─── RECENT SIGNALS (last ${recent.length}) ────────────────────`);

  for (const s of recent) {
    const arrow  = s.verdict === "BUY" ? "▲" : s.verdict === "SELL" ? "▼" : "—";
    const grade  = s.meta?.grade || "?";
    const outcome = s.outcome ? (s.outcome === "win" ? " ✓ WIN" : " ✗ LOSS") : " ○ open";
    const ts     = s.meta?.timestamp || s.logged_at || "";
    const date   = ts ? new Date(ts).toLocaleDateString() : "?";
    const id     = ts.replace(/[^0-9]/g, "").slice(0, 10);

    console.log(
      `  ${arrow} ${String(s.meta?.asset || "?").padEnd(8)} [${grade}] ` +
      `${String(s.confidence || 0).padStart(3)}% conf  ` +
      `${(s.rr_ratio || "?").padEnd(6)}  ` +
      `${date}  ${outcome}  (id: ${id})`
    );
  }

  console.log(`\nMark outcome: node src/journal.js --win <id> | --loss <id>`);
  console.log(`Full stats:   node src/journal.js --stats\n`);
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

const signals = loadAllSignals();

if (hasFlag("--stats")) {
  printStats(signals);
} else if (getArg("--win")) {
  const id = getArg("--win");
  const ok = saveOutcome(id, "win");
  console.log(ok ? `✓ Marked ${id} as WIN` : `✗ Signal not found: ${id}`);
} else if (getArg("--loss")) {
  const id = getArg("--loss");
  const ok = saveOutcome(id, "loss");
  console.log(ok ? `✓ Marked ${id} as LOSS` : `✗ Signal not found: ${id}`);
} else if (getArg("--grade")) {
  const grade = getArg("--grade");
  const filtered = signals.filter((s) => s.meta?.grade === grade);
  printSignals(filtered);
} else {
  printSignals(signals);
}
