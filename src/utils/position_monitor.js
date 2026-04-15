/**
 * Position Monitor — Trailing Stop Manager
 *
 * Watches open MT5 positions and tightens the stop loss as price moves in
 * our favour. Uses R-based rules (no ATR needed):
 *
 *   Profit >= 1R  → move SL to breakeven (protect capital)
 *   Profit >= 2R  → move SL to +1R      (lock in profit)
 *
 * Runs on a separate interval inside watch.js.
 */

export class PositionMonitor {
  constructor({ bridgeUrl, bridgeSecret, telegram }) {
    this.bridgeUrl    = bridgeUrl;
    this.bridgeSecret = bridgeSecret;
    this.telegram     = telegram;
    // Track which tickets we've already trailed so we don't spam Telegram
    this._trailed = new Map(); // ticket → last trail level ("be" | "1r")
  }

  // ── BRIDGE CALLS ──────────────────────────────────────────────────────────

  async _fetch(path, options = {}) {
    const res = await fetch(`${this.bridgeUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(this.bridgeSecret ? { "X-Secret": this.bridgeSecret } : {}),
        ...(options.headers || {}),
      },
    });
    return res.json();
  }

  async getPositions() {
    return this._fetch("/positions");
  }

  async modifySL(ticket, sl, tp) {
    return this._fetch(`/modify/${ticket}`, {
      method: "POST",
      body: JSON.stringify({ sl, tp }),
    });
  }

  async getAccount() {
    return this._fetch("/account");
  }

  // ── DAILY LOSS GUARD ──────────────────────────────────────────────────────

  async checkDailyLoss({ maxDailyLossPct = 3 } = {}) {
    try {
      const acc = await this.getAccount();
      if (!acc.balance) return false;

      const lossAmount  = acc.balance - acc.equity;
      const lossPct     = (lossAmount / acc.balance) * 100;

      if (lossPct >= maxDailyLossPct) {
        console.warn(`[Monitor] ⛔ Daily loss limit hit: -${lossPct.toFixed(1)}% (limit ${maxDailyLossPct}%)`);
        if (this.telegram?.enabled) {
          await this.telegram.sendText(
            `⛔ *Daily loss limit reached!*\n` +
            `-${lossPct.toFixed(1)}% drawdown today.\n` +
            `Bot paused — no new trades until tomorrow.`
          );
        }
        return true; // caller should skip new trades
      }
    } catch {}
    return false;
  }

  // ── TRAILING STOP LOGIC ───────────────────────────────────────────────────

  async trailPosition(pos) {
    const { ticket, side, entry, current, sl, tp, profit, symbol } = pos;

    if (!sl || !tp || sl === 0 || tp === 0) return; // no levels set
    if (profit <= 0) return;                         // not in profit yet

    const initialRisk   = Math.abs(entry - sl);
    if (initialRisk === 0) return;

    const lastLevel = this._trailed.get(ticket) || "none";

    if (side === "BUY") {
      const profitPoints = current - entry;
      const is1R = profitPoints >= initialRisk;
      const is2R = profitPoints >= initialRisk * 2;

      if (is2R && lastLevel !== "2r") {
        // Lock in 1R profit — move SL to entry + 1R
        const newSL = parseFloat((entry + initialRisk).toFixed(5));
        if (newSL > sl) {
          const res = await this.modifySL(ticket, newSL, tp);
          if (res.success) {
            this._trailed.set(ticket, "2r");
            console.log(`[Monitor] 🔒 ${symbol} BUY #${ticket} — SL locked at +1R (${newSL.toFixed(2)})`);
            await this.telegram?.sendText(
              `🔒 *Trailing stop updated*\n` +
              `${symbol} BUY — profit reached 2R\n` +
              `SL moved to *+1R* at \`${newSL.toFixed(2)}\` (profit locked)`
            );
          }
        }
      } else if (is1R && lastLevel === "none") {
        // Move SL to breakeven
        const newSL = parseFloat((entry + 0.0001).toFixed(5)); // tiny buffer above entry
        if (newSL > sl) {
          const res = await this.modifySL(ticket, newSL, tp);
          if (res.success) {
            this._trailed.set(ticket, "1r");
            console.log(`[Monitor] 🔒 ${symbol} BUY #${ticket} — SL moved to breakeven (${newSL.toFixed(2)})`);
            await this.telegram?.sendText(
              `🔒 *Trailing stop updated*\n` +
              `${symbol} BUY — profit reached 1R\n` +
              `SL moved to *breakeven* at \`${newSL.toFixed(2)}\` (no loss possible)`
            );
          }
        }
      }
    } else {
      // SELL — mirror logic
      const profitPoints = entry - current;
      const is1R = profitPoints >= initialRisk;
      const is2R = profitPoints >= initialRisk * 2;

      if (is2R && lastLevel !== "2r") {
        const newSL = parseFloat((entry - initialRisk).toFixed(5));
        if (newSL < sl) {
          const res = await this.modifySL(ticket, newSL, tp);
          if (res.success) {
            this._trailed.set(ticket, "2r");
            console.log(`[Monitor] 🔒 ${symbol} SELL #${ticket} — SL locked at +1R (${newSL.toFixed(2)})`);
            await this.telegram?.sendText(
              `🔒 *Trailing stop updated*\n` +
              `${symbol} SELL — profit reached 2R\n` +
              `SL moved to *+1R* at \`${newSL.toFixed(2)}\` (profit locked)`
            );
          }
        }
      } else if (is1R && lastLevel === "none") {
        const newSL = parseFloat((entry - 0.0001).toFixed(5));
        if (newSL < sl) {
          const res = await this.modifySL(ticket, newSL, tp);
          if (res.success) {
            this._trailed.set(ticket, "1r");
            console.log(`[Monitor] 🔒 ${symbol} SELL #${ticket} — SL moved to breakeven (${newSL.toFixed(2)})`);
            await this.telegram?.sendText(
              `🔒 *Trailing stop updated*\n` +
              `${symbol} SELL — profit reached 1R\n` +
              `SL moved to *breakeven* at \`${newSL.toFixed(2)}\` (no loss possible)`
            );
          }
        }
      }
    }
  }

  // ── MAIN LOOP TICK ────────────────────────────────────────────────────────

  async tick() {
    let positions;
    try {
      positions = await this.getPositions();
    } catch (err) {
      // Bridge not running — silently skip
      return;
    }

    if (!Array.isArray(positions) || positions.length === 0) {
      // Clean up closed positions from our map
      this._trailed.clear();
      console.log(`[Monitor] No open positions — ${new Date().toLocaleTimeString("en-PH", { timeZone: "Asia/Manila" })} PH`);
      return;
    }

    const openTickets = new Set(positions.map((p) => p.ticket));

    // Remove closed positions from trail map
    for (const ticket of this._trailed.keys()) {
      if (!openTickets.has(ticket)) {
        this._trailed.delete(ticket);
      }
    }

    // Trail each open position
    for (const pos of positions) {
      try {
        await this.trailPosition(pos);
      } catch (err) {
        console.error(`[Monitor] Error trailing #${pos.ticket}:`, err.message);
      }
    }

    // Log summary
    const totalProfit = positions.reduce((s, p) => s + p.profit, 0);
    console.log(
      `[Monitor] ${positions.length} open position(s) | ` +
      `floating P&L: ${totalProfit >= 0 ? "+" : ""}$${totalProfit.toFixed(2)}`
    );
  }
}
