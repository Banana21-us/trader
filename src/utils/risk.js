export class RiskEngine {
  constructor() {
    // Track trade history for drawdown calculation
    this.tradeHistory = [];
    // Track current position sizes for position limits
    this.currentPositions = new Map();
  }

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

    // Apply position sizing limits and drawdown controls
    const { adjustedPositionSize, positionLimitReason } = this.applyPositionLimits(
      signal, 
      positionSize, 
      riskAmount, 
      balance,
      asset
    );

    const { maxDrawdownAllowed, drawdownLimitReason } = this.checkDrawdownLimits(
      signal,
      balance,
      this.tradeHistory
    );

    return {
      ...signal,
      meta: {
        asset,
        balance,
        riskPct,
        riskAmount:  parseFloat(riskAmount.toFixed(2)),
        maxReward:   parseFloat(maxReward.toFixed(2)),
        positionSize: adjustedPositionSize,
        originalPositionSize: positionSize,
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
        // Risk management metadata
        maxDrawdownAllowed,
        positionLimitReason,
        drawdownLimitReason,
        // Track position for future calculations
        assetPosition: this.currentPositions.get(asset) || 0,
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
    if (!["A+", "A"].includes(grade))  return false;
    if (signal.verdict === "NEUTRAL")  return false;

    const entry = this.parsePrice(signal.entry);
    const sl    = this.parsePrice(signal.stop_loss);
    const tp    = this.parsePrice(signal.take_profit);

    // Sanity guards — catches LLM hallucinations that the grade alone misses
    if (!entry || !sl || !tp) return false;

    // R:R to primary TP must be ≥ 1.8 (after spread/slippage, anything less is a coin flip)
    const primaryRR = this.calcRR(entry, sl, tp);
    if (!primaryRR || primaryRR < 1.8) return false;

    // SL distance must be between 0.05% and 5% of price — catches obvious bad levels
    const slDistPct = (Math.abs(entry - sl) / entry) * 100;
    if (slDistPct < 0.05 || slDistPct > 5) return false;

    // SL must be on the correct side of entry
    if (signal.verdict === "BUY"  && sl >= entry) return false;
    if (signal.verdict === "SELL" && sl <= entry) return false;
    if (signal.verdict === "BUY"  && tp <= entry) return false;
    if (signal.verdict === "SELL" && tp >= entry) return false;

    return true;
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
  Position Size: ${meta.positionSize || 0} units${meta.originalPositionSize && meta.originalPositionSize !== meta.positionSize ? ` (adjusted from ${meta.originalPositionSize})` : ''}

─── RISK MANAGEMENT ────────────────────────────────
  Max Drawdown Allowed: ${meta.maxDrawdownAllowed !== null ? `${meta.maxDrawdownAllowed}%` : 'Not set'}
  Position Limit Reason: ${meta.positionLimitReason || 'None'}
  Drawdown Limit Reason: ${meta.drawdownLimitReason || 'None'}

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

  /**
   * Apply position sizing limits based on asset and risk parameters
   */
  applyPositionLimits(signal, positionSize, riskAmount, balance, asset) {
    // If no position size can be calculated, return as is
    if (!positionSize) {
      return { adjustedPositionSize: positionSize, positionLimitReason: null };
    }

    const adjustedPositionSize = parseFloat(positionSize);
    
    // Configuration for position limits
    const maxPositionSize = 10000; // Maximum position size for any single asset
    const maxTotalPosition = balance * 0.3; // Maximum total position value (30% of balance)
    const maxAssetPosition = balance * 0.1; // Maximum position value per asset (10% of balance)
    
    let reason = null;

    // Check if position size exceeds maximum
    if (adjustedPositionSize > maxPositionSize) {
      const ratio = maxPositionSize / adjustedPositionSize;
      const newAdjustedSize = (adjustedPositionSize * ratio).toFixed(4);
      reason = `Position size reduced from ${adjustedPositionSize} to ${newAdjustedSize} due to maximum limit of ${maxPositionSize}`;
      return { adjustedPositionSize: newAdjustedSize, positionLimitReason: reason };
    }

    // Check if total position value exceeds 30% of balance
    const totalPositionValue = adjustedPositionSize * riskAmount;
    if (totalPositionValue > maxTotalPosition) {
      const ratio = maxTotalPosition / totalPositionValue;
      const newAdjustedSize = (adjustedPositionSize * ratio).toFixed(4);
      reason = `Position size reduced from ${adjustedPositionSize} to ${newAdjustedSize} due to total position limit of 30% of balance`;
      return { adjustedPositionSize: newAdjustedSize, positionLimitReason: reason };
    }

    // Check if position value for this asset exceeds 10% of balance
    const currentAssetPositionValue = (this.currentPositions.get(asset) || 0) * riskAmount;
    const newAssetPositionValue = currentAssetPositionValue + (adjustedPositionSize * riskAmount);
    
    if (newAssetPositionValue > maxAssetPosition) {
      const ratio = maxAssetPosition / newAssetPositionValue;
      const newAdjustedSize = (adjustedPositionSize * ratio).toFixed(4);
      reason = `Position size reduced from ${adjustedPositionSize} to ${newAdjustedSize} due to asset position limit of 10% of balance`;
      return { adjustedPositionSize: newAdjustedSize, positionLimitReason: reason };
    }

    // Update current positions tracking
    const existingPosition = this.currentPositions.get(asset) || 0;
    this.currentPositions.set(asset, existingPosition + adjustedPositionSize);

    return { adjustedPositionSize, positionLimitReason: reason };
  }

  /**
   * Check if we're within maximum drawdown limits
   */
  checkDrawdownLimits(signal, balance, tradeHistory) {
    // Configuration for drawdown limits
    const maxDrawdownPercentage = 10; // Maximum 10% drawdown allowed
    const maxDrawdownAllowed = maxDrawdownPercentage;
    
    // If no trade history, no drawdown limit applies
    if (!tradeHistory || tradeHistory.length === 0) {
      return { maxDrawdownAllowed, drawdownLimitReason: null };
    }

    // Calculate current equity based on trade history
    let currentEquity = balance;
    let maxEquity = balance;
    
    for (const trade of tradeHistory) {
      if (trade.outcome === "win") {
        currentEquity += trade.meta.riskAmount;
      } else if (trade.outcome === "loss") {
        currentEquity -= trade.meta.riskAmount;
      }
      
      // Track maximum equity for drawdown calculation
      if (currentEquity > maxEquity) {
        maxEquity = currentEquity;
      }
    }
    
    // Calculate drawdown percentage
    const drawdownPercentage = ((maxEquity - currentEquity) / maxEquity) * 100;
    
    let reason = null;
    
    if (drawdownPercentage > maxDrawdownPercentage) {
      reason = `Drawdown limit exceeded: ${drawdownPercentage.toFixed(2)}% > ${maxDrawdownPercentage}%`;
      return { maxDrawdownAllowed, drawdownLimitReason: reason };
    }

    return { maxDrawdownAllowed, drawdownLimitReason: reason };
  }

  /**
   * Add a trade to history for drawdown tracking
   */
  addTradeToHistory(trade) {
    this.tradeHistory.push(trade);
  }

  /**
   * Update the current positions based on trade outcome
   */
  updatePositions(trade) {
    const { meta, verdict, asset } = trade;
    const position = parseFloat(meta.positionSize || 0);
    
    if (verdict === "BUY") {
      this.currentPositions.set(asset, (this.currentPositions.get(asset) || 0) + position);
    } else if (verdict === "SELL") {
      this.currentPositions.set(asset, (this.currentPositions.get(asset) || 0) - position);
    }
  }

  /**
   * Calculate current drawdown based on trade history
   */
  getCurrentDrawdown() {
    if (!this.tradeHistory || this.tradeHistory.length === 0) return 0;
    
    let currentEquity = 0;
    let maxEquity = 0;
    
    // Initialize with first trade if available
    if (this.tradeHistory.length > 0) {
      currentEquity = this.tradeHistory[0].meta.balance || 0;
      maxEquity = currentEquity;
    }
    
    for (const trade of this.tradeHistory) {
      if (trade.outcome === "win") {
        currentEquity += trade.meta.riskAmount;
      } else if (trade.outcome === "loss") {
        currentEquity -= trade.meta.riskAmount;
      }
      
      if (currentEquity > maxEquity) {
        maxEquity = currentEquity;
      }
    }
    
    if (maxEquity === 0) return 0;
    return ((maxEquity - currentEquity) / maxEquity) * 100;
  }

  /**
   * Reset current positions for a new trading session
   */
  resetPositions() {
    this.currentPositions.clear();
  }
}