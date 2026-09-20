/**
 * Expectancy measurement.
 *
 * "Does this system have an edge" is a statistics question, not a P&L
 * question. A positive total over 20 trades is noise: with a typical
 * per-trade standard deviation around 1.5R, the 95% band on the mean is
 * still +/-0.65R at n=20 — wide enough to contain both a great system and
 * a losing one. This module refuses to call an edge before the sample
 * supports it.
 *
 * Everything is measured in R (multiples of initial risk) so results are
 * comparable across account sizes and instruments.
 */

const Z95 = 1.96;

export function computeExpectancy(trades, { minSample = 30 } = {}) {
  const rs = trades
    .map((t) => (t.r_multiple ?? t.rMultiple ?? t.r))
    .filter((r) => Number.isFinite(r));

  const n = rs.length;
  if (n === 0) {
    return {
      n: 0, proven: false, verdict: "no data",
      expectancyR: null, ciLow: null, ciHigh: null,
      winRate: null, avgWinR: null, avgLossR: null,
      profitFactor: null, sd: null, maxDrawdownR: null,
      requiredSample: null,
    };
  }

  const wins   = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);

  const mean = rs.reduce((s, r) => s + r, 0) / n;
  const variance = n > 1
    ? rs.reduce((s, r) => s + (r - mean) ** 2, 0) / (n - 1)
    : 0;
  const sd     = Math.sqrt(variance);
  const stderr = sd / Math.sqrt(n);

  const ciLow  = mean - Z95 * stderr;
  const ciHigh = mean + Z95 * stderr;

  const grossWin  = wins.reduce((s, r) => s + r, 0);
  const grossLoss = Math.abs(losses.reduce((s, r) => s + r, 0));

  // Sample size at which the observed effect would clear zero, if the
  // observed mean and spread hold. Tells you how much further to run.
  const requiredSample = mean > 0 && sd > 0
    ? Math.ceil((Z95 * sd / mean) ** 2)
    : null;

  const proven = n >= minSample && ciLow > 0;

  return {
    n,
    proven,
    verdict: describeVerdict({ n, minSample, ciLow, ciHigh, mean }),
    expectancyR:  round(mean),
    ciLow:        round(ciLow),
    ciHigh:       round(ciHigh),
    winRate:      round((wins.length / n) * 100, 1),
    avgWinR:      wins.length   ? round(grossWin / wins.length)    : 0,
    avgLossR:     losses.length ? round(-grossLoss / losses.length) : 0,
    profitFactor: grossLoss > 0 ? round(grossWin / grossLoss) : null,
    sd:           round(sd),
    maxDrawdownR: round(maxDrawdownR(rs)),
    requiredSample,
  };
}

function describeVerdict({ n, minSample, ciLow, ciHigh, mean }) {
  if (n < minSample)  return `unproven — only ${n}/${minSample} trades`;
  if (ciLow > 0)      return "edge confirmed at 95%";
  if (ciHigh < 0)     return "negative edge confirmed at 95%";
  return mean > 0
    ? "positive but indistinguishable from noise"
    : "negative and indistinguishable from noise";
}

/** Peak-to-trough of the cumulative R curve. */
function maxDrawdownR(rs) {
  let equity = 0, peak = 0, maxDd = 0;
  for (const r of rs) {
    equity += r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDd) maxDd = dd;
  }
  return maxDd;
}

/**
 * Longest losing streak the system should expect at this win rate, at 95%
 * confidence. Tells you whether a cooldown guard is set sanely: a guard that
 * trips below this number will shut off a healthy system during normal variance.
 */
export function expectedLosingStreak(winRate, n) {
  const p = 1 - (winRate / 100);
  if (!(p > 0 && p < 1) || n < 1) return null;
  return Math.ceil(Math.log(n) / -Math.log(p));
}

function round(v, dp = 3) {
  return Number.isFinite(v) ? parseFloat(v.toFixed(dp)) : null;
}

export function formatExpectancy(e) {
  if (!e.n) return "  No closed trades yet — nothing to measure.\n";

  const flag = e.proven ? "PROVEN" : "NOT PROVEN";
  const streak = expectedLosingStreak(e.winRate, e.n);

  return `
  Sample        : ${e.n} closed trades
  Expectancy    : ${sign(e.expectancyR)}R per trade
  95% CI        : [${sign(e.ciLow)}R, ${sign(e.ciHigh)}R]
  Verdict       : ${e.verdict}  [${flag}]

  Win rate      : ${e.winRate}%
  Avg win       : ${sign(e.avgWinR)}R
  Avg loss      : ${sign(e.avgLossR)}R
  Profit factor : ${e.profitFactor ?? "—"}
  Std dev       : ${e.sd}R
  Max drawdown  : -${e.maxDrawdownR}R
${e.requiredSample && !e.proven ? `\n  Need ~${e.requiredSample} trades total for this edge to clear zero.` : ""}
${streak ? `  Expect losing streaks up to ${streak} in a row at this win rate.` : ""}
`;
}

function sign(v) {
  if (v === null || v === undefined) return "—";
  return v >= 0 ? `+${v}` : `${v}`;
}
