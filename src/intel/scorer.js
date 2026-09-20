/**
 * Source scoring — how a news or community source earns the right to matter.
 *
 * Every directional call is recorded with a resolve time and a price at call.
 * When that time passes the call is resolved against realised price and the
 * source's record updated. Influence is granted on the WILSON LOWER BOUND of
 * the hit rate, not the raw hit rate: 3 correct calls out of 3 is a 100% hit
 * rate and means nothing, and the lower bound is what refuses to be fooled
 * by it.
 *
 * Weight stays 0 until a source clears both the sample floor and the score
 * floor. Most sources never will. That is the point.
 */

const Z = 1.96;

export function wilsonLowerBound(successes, n, z = Z) {
  if (n === 0) return 0;
  const p = successes / n;
  const denom  = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.max(0, (centre - margin) / denom);
}

export class SourceScorer {
  constructor(store, { minResolvedCalls = 30, minWilsonLowerBound = 0.5, deadBandPct = 0.15 } = {}) {
    this.store = store;
    this.minResolvedCalls = minResolvedCalls;
    this.minWilsonLowerBound = minWilsonLowerBound;
    // Moves smaller than this are noise, not a correct call in either direction.
    this.deadBandPct = deadBandPct;
  }

  /**
   * Resolve every call whose horizon has elapsed.
   * `priceAt(symbol, ts)` must return the price at that time, or null.
   */
  async resolveDue(priceAt, now = Date.now()) {
    const due = this.store.pendingSourceCalls(now);
    let resolved = 0, skipped = 0;

    for (const call of due) {
      const priceNow = await priceAt(call.symbol, call.resolve_at);
      if (!priceNow || !call.price_at_call) { skipped++; continue; }

      const returnPct = ((priceNow - call.price_at_call) / call.price_at_call) * 100;

      let outcome;
      if (Math.abs(returnPct) < this.deadBandPct) {
        outcome = "flat";
      } else if (call.direction === "LONG") {
        outcome = returnPct > 0 ? "correct" : "wrong";
      } else {
        outcome = returnPct < 0 ? "correct" : "wrong";
      }

      this.store.resolveSourceCall(call.id, outcome, round(returnPct, 4));
      resolved++;
    }
    return { resolved, skipped, pending: due.length - resolved - skipped };
  }

  /** Recompute every source's score and weight from its resolved calls. */
  rescoreAll() {
    const out = [];
    for (const src of this.store.allSources()) {
      const tally = this.store.sourceCallTally(src.id);
      const n = tally?.n ?? 0;
      const nCorrect = tally?.n_correct ?? 0;

      const hitRate  = n > 0 ? nCorrect / n : null;
      const wilsonLb = wilsonLowerBound(nCorrect, n);

      const qualifies = n >= this.minResolvedCalls && wilsonLb >= this.minWilsonLowerBound;
      // Weight is the margin above a coin flip, not the hit rate itself.
      const weight = qualifies ? round((wilsonLb - 0.5) * 2, 4) : 0;
      const status = qualifies ? "trusted"
                   : n >= this.minResolvedCalls ? "rejected"
                   : "observing";

      this.store.saveSourceScore({
        sourceId: src.id, nResolved: n, nCorrect,
        hitRate: hitRate === null ? null : round(hitRate, 4),
        wilsonLb: round(wilsonLb, 4),
        avgReturn: tally?.avg_return ?? null,
        weight, status,
      });

      out.push({ handle: src.handle, kind: src.kind, n, nCorrect,
                 hitRate: hitRate === null ? null : round(hitRate * 100, 1),
                 wilsonLb: round(wilsonLb, 3), weight, status });
    }
    return out.sort((a, b) => b.wilsonLb - a.wilsonLb);
  }
}

export function formatScores(rows, { minResolvedCalls = 30 } = {}) {
  if (!rows.length) return "  No sources recorded yet.\n";
  const lines = [
    "",
    "  source                          n   hit%   wilsonLB  weight  status",
    "  " + "-".repeat(66),
  ];
  for (const r of rows) {
    lines.push(
      "  " +
      r.handle.slice(0, 28).padEnd(30) +
      String(r.n).padStart(3) +
      (r.hitRate === null ? "    — " : (r.hitRate + "%").padStart(7)) +
      String(r.wilsonLb).padStart(10) +
      String(r.weight).padStart(8) +
      "  " + r.status
    );
  }
  lines.push("", `  Weight stays 0 until >=${minResolvedCalls} resolved calls AND Wilson lower bound >= 0.5.`, "");
  return lines.join("\n");
}

function round(v, dp = 4) {
  return Number.isFinite(v) ? parseFloat(v.toFixed(dp)) : null;
}
