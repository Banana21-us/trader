/**
 * Round-trip execution cost model.
 *
 * Every price the strategy imagines is a price you do not get. Fees are
 * certain, slippage is near-certain, and both are charged twice per trade.
 * A backtest that omits them measures an edge that does not exist.
 */

export class CostModel {
  constructor({ takerFeeBps = 10, makerFeeBps = 10, slippageBps = 5, spreadBps = 0 } = {}) {
    this.takerFeeBps = takerFeeBps;
    this.makerFeeBps = makerFeeBps;
    this.slippageBps = slippageBps;
    this.spreadBps   = spreadBps;
  }

  static fromConfig(cfg) {
    return new CostModel({
      takerFeeBps: cfg.costs.takerFeeBps,
      makerFeeBps: cfg.costs.makerFeeBps,
      slippageBps: cfg.costs.slippageBps,
      spreadBps:   cfg.costs.spreadBps ?? 0,
    });
  }

  roundTripBps({ maker = false } = {}) {
    const feeBps = maker ? this.makerFeeBps : this.takerFeeBps;
    return 2 * (feeBps + this.slippageBps) + this.spreadBps;
  }

  /** Slippage always works against the direction you are taking. */
  fillPrice(intended, side, { maker = false } = {}) {
    if (maker) return intended;
    const slip = (this.slippageBps + this.spreadBps / 2) / 10_000;
    return side === "BUY" ? intended * (1 + slip) : intended * (1 - slip);
  }

  fee(price, qty, { maker = false } = {}) {
    const bps = maker ? this.makerFeeBps : this.takerFeeBps;
    return Math.abs(price * qty) * (bps / 10_000);
  }

  netPnl({ side, entryPx, exitPx, qty, makerEntry = false, makerExit = false }) {
    const gross = side === "BUY" ? (exitPx - entryPx) * qty : (entryPx - exitPx) * qty;
    return gross - this.fee(entryPx, qty, { maker: makerEntry })
                 - this.fee(exitPx,  qty, { maker: makerExit });
  }

  /**
   * Smallest stop distance where round-trip cost stays below `maxCostShare`
   * of the money at risk. A 5bps stop against a 14bps round trip is a
   * guaranteed loser no matter how good the signal is.
   */
  minStopDistance(price, maxCostShare = 0.25) {
    return (price * (this.roundTripBps() / 10_000)) / maxCostShare;
  }

  /** Cost expressed in R, given an intended stop distance. */
  costInR(price, stopDistance) {
    if (!stopDistance) return Infinity;
    return (price * (this.roundTripBps() / 10_000)) / stopDistance;
  }
}
