/**
 * Income feasibility.
 *
 * Translates a desired withdrawal rate into the equity and edge it actually
 * requires, and refuses to let a shortfall influence position size.
 *
 * The rule this module exists to enforce: a daily income target is an
 * OUTPUT of the system, never an INPUT to a sizing decision. Sizing up to
 * hit a quota on a slow day is the single most reliable way retail accounts
 * go to zero, and it defeats the consecutive-loss guard by design.
 */

const DEFAULT_PHP_PER_USD = 57;

export class IncomePlan {
  constructor({
    targetDailyPhp   = 0,
    phpPerUsd        = DEFAULT_PHP_PER_USD,
    tradingDaysPerMonth = 22,
    withdrawalBufferPct = 20,
  } = {}) {
    this.targetDailyPhp      = targetDailyPhp;
    this.phpPerUsd           = phpPerUsd;
    this.tradingDaysPerMonth = tradingDaysPerMonth;
    this.withdrawalBufferPct = withdrawalBufferPct;
  }

  get targetDailyUsd()   { return this.targetDailyPhp / this.phpPerUsd; }
  get targetMonthlyUsd() { return this.targetDailyUsd * this.tradingDaysPerMonth; }

  /**
   * Expected monthly return as a fraction of equity.
   * expectancy(R) x risk-per-trade(%) x trades-per-month = % growth.
   */
  monthlyReturnPct({ expectancyR, riskPctPerTrade, tradesPerMonth }) {
    if (!Number.isFinite(expectancyR)) return null;
    return expectancyR * riskPctPerTrade * tradesPerMonth;
  }

  /** Equity required to produce the target from a given monthly return. */
  equityRequired(monthlyReturnPct) {
    if (!monthlyReturnPct || monthlyReturnPct <= 0) return null;
    return this.targetMonthlyUsd / (monthlyReturnPct / 100);
  }

  /**
   * Honest assessment. Uses the LOWER bound of the expectancy confidence
   * interval, not the point estimate — planning income off a point estimate
   * from a thin sample is how people fund a system that never had an edge.
   */
  assess({ equity, expectancy, riskPctPerTrade, tradesPerMonth, minNotionalUsd = 5 }) {
    const riskPerTradeUsd = equity * (riskPctPerTrade / 100);
    const sizingViable    = riskPerTradeUsd >= minNotionalUsd;

    const base = {
      targetDailyPhp: this.targetDailyPhp,
      targetDailyUsd: round(this.targetDailyUsd, 2),
      targetMonthlyUsd: round(this.targetMonthlyUsd, 2),
      equity,
      riskPerTradeUsd: round(riskPerTradeUsd, 2),
      sizingViable,
      requiredDailyReturnPct: equity > 0 ? round((this.targetDailyUsd / equity) * 100, 2) : null,
    };

    if (!expectancy || !expectancy.n) {
      return { ...base, status: "unmeasured",
        reason: "No closed trades. Expectancy is unknown, so any income figure would be invented." };
    }

    if (!expectancy.proven) {
      return { ...base, status: "unproven",
        reason: `Edge not established (${expectancy.verdict}). Income planning is premature.`,
        expectancyR: expectancy.expectancyR };
    }

    const conservativeR = expectancy.ciLow;
    const monthlyPct    = this.monthlyReturnPct({
      expectancyR: conservativeR, riskPctPerTrade, tradesPerMonth,
    });
    const supportableMonthlyUsd = equity * (monthlyPct / 100);
    const supportableDailyPhp   = (supportableMonthlyUsd / this.tradingDaysPerMonth) * this.phpPerUsd;

    return {
      ...base,
      status: supportableDailyPhp >= this.targetDailyPhp ? "feasible" : "underfunded",
      expectancyR: expectancy.expectancyR,
      conservativeR: round(conservativeR, 3),
      monthlyReturnPct: round(monthlyPct, 2),
      supportableDailyPhp: round(supportableDailyPhp, 0),
      equityRequired: round(this.equityRequired(monthlyPct), 0),
    };
  }

  /**
   * Withdrawable surplus above the high-water mark, keeping a buffer so a
   * normal drawdown does not immediately eat into the trading float.
   * Returns 0 whenever equity is at or below the mark.
   */
  withdrawable(equity, highWaterMark) {
    const buffered = highWaterMark * (1 + this.withdrawalBufferPct / 100);
    return equity > buffered ? round(equity - buffered, 2) : 0;
  }
}

export function formatAssessment(a) {
  const lines = [
    "",
    `  Target        : PHP ${a.targetDailyPhp}/day  ($${a.targetDailyUsd}/day, $${a.targetMonthlyUsd}/mo)`,
    `  Equity        : $${a.equity}`,
    `  Risk / trade  : $${a.riskPerTradeUsd}`,
    `  Needs         : ${a.requiredDailyReturnPct}% per day`,
    "",
  ];

  if (!a.sizingViable) {
    lines.push(
      `  [BLOCKED] Risk per trade ($${a.riskPerTradeUsd}) is below exchange minimum notional.`,
      `            Position size is quantized by the exchange, not by your risk model.`,
      ""
    );
  }

  if (a.status === "unmeasured" || a.status === "unproven") {
    lines.push(`  Status        : ${a.status.toUpperCase()}`, `  ${a.reason}`, "");
    return lines.join("\n");
  }

  lines.push(
    `  Expectancy    : ${a.expectancyR}R (planning on lower bound ${a.conservativeR}R)`,
    `  Monthly return: ${a.monthlyReturnPct}%`,
    `  Supports      : PHP ${a.supportableDailyPhp}/day at current equity`,
    `  Status        : ${a.status.toUpperCase()}`,
  );

  if (a.status === "underfunded" && a.equityRequired) {
    lines.push(`  Equity needed : $${a.equityRequired} for PHP ${a.targetDailyPhp}/day`);
  }
  lines.push("");
  return lines.join("\n");
}

function round(v, dp = 2) {
  return Number.isFinite(v) ? parseFloat(v.toFixed(dp)) : null;
}
