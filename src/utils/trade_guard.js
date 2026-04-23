/**
 * TradeGuard — pre-execution safety checks
 *
 * Blocks trades when:
 *   - Asset already has an open position (no pyramiding)
 *   - N consecutive losers in recent history (tilt protection)
 *   - High-impact economic event within news-blackout window
 *   - Account floating loss exceeds daily cutoff
 *
 * Returns { allow: bool, reason: string }.
 */

export class TradeGuard {
  constructor({ bridgeUrl, bridgeSecret, newsFetcher, config = {} } = {}) {
    this.bridgeUrl    = bridgeUrl;
    this.bridgeSecret = bridgeSecret;
    this.newsFetcher  = newsFetcher;

    this.maxConsecutiveLosses = config.maxConsecutiveLosses ?? 3;
    this.lossCooldownHours    = config.lossCooldownHours    ?? 6;
    this.newsBlackoutMinutes  = config.newsBlackoutMinutes  ?? 30;
    this.maxDailyLossPct      = config.maxDailyLossPct      ?? 3;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.bridgeSecret) h["X-Secret"] = this.bridgeSecret;
    return h;
  }

  async _fetch(path) {
    try {
      const res = await fetch(`${this.bridgeUrl}${path}`, { headers: this._headers() });
      return await res.json();
    } catch {
      return null;
    }
  }

  /** Main entry point — call before executing any trade. */
  async check({ asset, skipChecks = [] } = {}) {
    const checks = [
      !skipChecks.includes("position")   && (() => this.checkNoOpenPosition(asset)),
      !skipChecks.includes("losses")     && (() => this.checkConsecutiveLosses()),
      !skipChecks.includes("news")       && (() => this.checkNewsWindow(asset)),
      !skipChecks.includes("drawdown")   && (() => this.checkDailyLoss()),
    ].filter(Boolean);

    for (const check of checks) {
      const result = await check();
      if (!result.allow) return result;
    }
    return { allow: true, reason: "all checks passed" };
  }

  // ── CHECK 1: no open position on this asset ──────────────────────────────
  async checkNoOpenPosition(asset) {
    const positions = await this._fetch("/positions");
    if (!Array.isArray(positions)) return { allow: true, reason: "bridge unavailable (skipping position check)" };

    const existing = positions.find((p) => p.symbol === asset);
    if (existing) {
      return {
        allow: false,
        reason: `Already have open ${existing.side} position on ${asset} (ticket ${existing.ticket})`,
      };
    }
    return { allow: true };
  }

  // ── CHECK 2: consecutive loss kill switch ────────────────────────────────
  async checkConsecutiveLosses() {
    const deals = await this._fetch("/history?hours=24");
    if (!Array.isArray(deals) || deals.length === 0) return { allow: true };

    // deals are newest first; count consecutive losers from the most recent
    let streak = 0;
    let lastLossTime = null;
    for (const d of deals) {
      if (d.profit < 0) {
        streak++;
        if (!lastLossTime) lastLossTime = new Date(d.time);
      } else if (d.profit > 0) {
        break; // streak broken by a winner
      }
    }

    if (streak < this.maxConsecutiveLosses) return { allow: true };

    // Still within cooldown?
    const hoursSinceLoss = lastLossTime ? (Date.now() - lastLossTime.getTime()) / 3_600_000 : 999;
    if (hoursSinceLoss < this.lossCooldownHours) {
      return {
        allow: false,
        reason: `${streak} consecutive losses — cooling down for ${(this.lossCooldownHours - hoursSinceLoss).toFixed(1)}h more`,
      };
    }
    return { allow: true };
  }

  // ── CHECK 3: high-impact news blackout window ────────────────────────────
  async checkNewsWindow(asset) {
    if (!this.newsFetcher?.getUpcomingHighImpact) return { allow: true };

    try {
      const events = await this.newsFetcher.getUpcomingHighImpact(asset, this.newsBlackoutMinutes);
      if (events.length > 0) {
        const e = events[0];
        return {
          allow: false,
          reason: `High-impact event "${e.title}" (${e.country}) in ${e.minutesUntil}min — blackout active`,
        };
      }
    } catch {}
    return { allow: true };
  }

  // ── CHECK 4: daily loss cutoff ───────────────────────────────────────────
  async checkDailyLoss() {
    const acc = await this._fetch("/account");
    if (!acc?.balance) return { allow: true };

    const lossPct = ((acc.balance - acc.equity) / acc.balance) * 100;
    if (lossPct >= this.maxDailyLossPct) {
      return {
        allow: false,
        reason: `Daily loss limit hit (-${lossPct.toFixed(1)}%) — no new trades today`,
      };
    }
    return { allow: true };
  }
}
