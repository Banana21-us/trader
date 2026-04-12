export class RiskEngine {
  enrich(signal, { balance, riskPct, asset }) {
    const riskAmount = balance * (riskPct / 100);

    const entryPrice = this.parsePrice(signal.entry);
    const slPrice    = this.parsePrice(signal.stop_loss);
    const tp1Price   = this.parsePrice(signal.take_profit);
    const tp2Price   = this.parsePrice(signal.tp2);
    const tp3Price   = this.parsePrice(signal.tp3);

    let positionSize = null;
    let pipRisk      = null;

    if (entryPrice && slPrice) {
      pipRisk = Math.abs(entryPrice - slPrice);
      if (pipRisk > 0) {
        positionSize = (riskAmount / pipRisk).toFixed(4);
      }
    }

    // R:R to each TP level
    const rrTp1 = this.calcRR(entryPrice, slPrice, tp1Price);
    const rrTp2 = this.calcRR(entryPrice, slPrice, tp2Price);
    const rrTp3 = this.calcRR(entryPrice, slPrice, tp3Price);

    // Max reward uses TP2 as primary target (most realistic)
    const primaryRR  = rrTp2 || rrTp1 || 2;
    const maxReward  = riskAmount * primaryRR;

    const grade = this.gradeSignal(signal);

    return {
      ...signal,
      meta: {
        asset,
        balance,
        riskPct,
        riskAmount:  parseFloat(riskAmount.toFixed(2)),
        maxReward:   parseFloat(maxReward.toFixed(2)),
        positionSize,
        pipRisk:     pipRisk ? parseFloat(pipRisk.toFixed(5)) : null,
        rrTp1,
        rrTp2,
        rrTp3,
        grade,
        timestamp:   new Date().toISOString(),
        session:     signal.session || "unknown",
        isTradeworthy: this.isTradeworthy(signal),
        // Partial close amounts
        partialAmounts: this.calcPartialAmounts(riskAmount, rrTp1, rrTp2, rrTp3, grade),
      },
    };
  }

  parsePrice(str) {
    if (!str) return null;
    const match = String(str).match(/[\d.]+/);
    return match ? parseFloat(match[0]) : null;
  }

  calcRR(entry, sl, tp) {
    if (!entry || !sl || !tp) return null;
    const risk   = Math.abs(entry - sl);
    const reward = Math.abs(tp - entry);
    if (risk === 0) return null;
    return parseFloat((reward / risk).toFixed(2));
  }

  // Calculate dollar amounts for each partial close
  calcPartialAmounts(riskAmount, rrTp1, rrTp2, rrTp3, grade) {
    if (!rrTp1) return null;

    if (grade === "A+") {
      // 30% at TP1, 40% at TP2, 30% at TP3
      return {
        tp1: { pct: 30, amount: parseFloat((riskAmount * (rrTp1 || 2) * 0.30).toFixed(2)) },
        tp2: { pct: 40, amount: parseFloat((riskAmount * (rrTp2 || 3.5) * 0.40).toFixed(2)) },
        tp3: { pct: 30, amount: parseFloat((riskAmount * (rrTp3 || 5) * 0.30).toFixed(2)) },
      };
    }
    // A grade: 40% at TP1, 40% at TP2, 20% at TP3
    return {
      tp1: { pct: 40, amount: parseFloat((riskAmount * (rrTp1 || 1.5) * 0.40).toFixed(2)) },
      tp2: { pct: 40, amount: parseFloat((riskAmount * (rrTp2 || 3) * 0.40).toFixed(2)) },
      tp3: { pct: 20, amount: parseFloat((riskAmount * (rrTp3 || 5) * 0.20).toFixed(2)) },
    };
  }

  gradeSignal(signal) {
    const conf     = signal.confidence || 0;
    const rrNum    = this.parseRR(signal.rr_ratio);
    const allAgree =
      signal.trend_vote     === signal.verdict &&
      signal.sr_vote        === signal.verdict &&
      signal.momentum_vote  === signal.verdict;

    // Bonus factors
    const hasOB  = signal.order_block && signal.order_block !== "null";
    const hasFVG = signal.fvg && signal.fvg !== "null";
    const hasFib = signal.fibonacci_level && signal.fibonacci_level !== "null";
    const hasLiq = signal.liquidity_level && signal.liquidity_level !== "null";
    const confluenceScore = [hasOB, hasFVG, hasFib, hasLiq].filter(Boolean).length;

    if (conf >= 85 && rrNum >= 4 && allAgree && confluenceScore >= 2) return "A+";
    if (conf >= 78 && rrNum >= 3) return "A";
    if (conf >= 68 && rrNum >= 2) return "B";
    if (conf >= 55 && rrNum >= 1.5) return "C";
    return "skip";
  }

  parseRR(rrStr) {
    if (!rrStr) return 0;
    const parts = String(rrStr).split(":");
    return parts.length > 1 ? parseFloat(parts[1]) || 0 : 0;
  }

  isTradeworthy(signal) {
    const grade = this.gradeSignal(signal);
    return ["A+", "A"].includes(grade) && signal.verdict !== "NEUTRAL";
  }

  formatReport(enriched) {
    const { meta }  = enriched;
    const verdict   = enriched.verdict;
    const arrow     = verdict === "BUY" ? "▲" : verdict === "SELL" ? "▼" : "—";
    const gradeStr  = meta.grade === "A+" ? "A+ ⭐" : meta.grade;
    const pa        = meta.partialAmounts;

    const rrLine = [
      meta.rrTp1 ? `TP1=1:${meta.rrTp1}` : null,
      meta.rrTp2 ? `TP2=1:${meta.rrTp2}` : null,
      meta.rrTp3 ? `TP3=1:${meta.rrTp3}` : null,
    ].filter(Boolean).join("  ");

    return `
╔══════════════════════════════════════════════════╗
║         SENIOR TRADER SIGNAL — ${(meta.asset || "").padEnd(16)}║
╚══════════════════════════════════════════════════╝

${arrow} VERDICT:      ${verdict} (${enriched.confidence}% confidence) [${gradeStr}]
  Summary:      ${enriched.summary || ""}
  Weekly Bias:  ${enriched.weekly_bias || "?"}
  Entry Type:   ${enriched.entry_type || "Market Order"}

─── MODEL CONSENSUS ────────────────────────────────
  Trend:        ${enriched.trend_vote} (${enriched.trend_conf}%) — ${enriched.trend_note || ""}
  S/R:          ${enriched.sr_vote} (${enriched.sr_conf}%) — ${enriched.sr_note || ""}
  Momentum:     ${enriched.momentum_vote} (${enriched.momentum_conf}%) — ${enriched.momentum_note || ""}

─── SMART MONEY LEVELS ─────────────────────────────
  Order Block:  ${enriched.order_block || "not identified"}
  FVG:          ${enriched.fvg || "not identified"}
  Liquidity:    ${enriched.liquidity_level || "not identified"}
  Fibonacci:    ${enriched.fibonacci_level || "not used"}

─── TRADE LEVELS ───────────────────────────────────
  Entry:        ${enriched.entry}
  Stop Loss:    ${enriched.stop_loss}
  TP1 (${pa?.tp1?.pct || 40}%):    ${enriched.take_profit}${pa?.tp1 ? `  → +$${pa.tp1.amount}` : ""}
  TP2 (${pa?.tp2?.pct || 40}%):    ${enriched.tp2 || "—"}${pa?.tp2 ? `  → +$${pa.tp2.amount}` : ""}
  TP3 (${pa?.tp3?.pct || 20}%):    ${enriched.tp3 || "—"}${pa?.tp3 ? `  → +$${pa.tp3.amount}` : ""}
  R:R:          ${rrLine || enriched.rr_ratio || "?"}

─── RISK CALCULATION ───────────────────────────────
  Balance:      $${(meta.balance || 0).toLocaleString()}
  Risk:         ${meta.riskPct}% = $${meta.riskAmount}${meta.positionSize ? `  (${meta.positionSize} units)` : ""}
  Max Reward:   $${meta.maxReward} (to TP2)

─── KEY LEVELS ─────────────────────────────────────
  ${enriched.key_levels || ""}

─── REASONING ──────────────────────────────────────
  ${enriched.reasoning || ""}

─── INVALIDATION ───────────────────────────────────
  ${enriched.invalidation || ""}
  Grade detail: ${enriched.trade_quality_detail || ""}

  Tradeable: ${meta.isTradeworthy ? "YES ✓" : "NO ✗ (below A grade)"}
  Time:      ${meta.timestamp}
${"═".repeat(50)}
`;
  }
}
