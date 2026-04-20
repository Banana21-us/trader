/**
 * Broker execution layer
 *
 * Implement one of these adapters based on your broker:
 *   - DerivAdapter   (Deriv / Binary.com — WebSocket API)
 *   - OandaAdapter   (OANDA — REST API)
 *   - BinanceAdapter (Binance Futures — REST API)
 *   - MTBridgeAdapter (MetaTrader 4/5 via local REST bridge)
 *
 * Set BROKER=deriv|oanda|binance|mt in env to select adapter.
 */

export class BrokerExecutor {
  constructor() {
    const broker = process.env.BROKER || "paper";
    this.adapter = this.createAdapter(broker);
    this.paperLedger = [];
  }

  createAdapter(broker) {
    switch (broker.toLowerCase()) {
      case "deriv":   return new DerivAdapter();
      case "oanda":   return new OandaAdapter();
      case "binance": return new BinanceAdapter();
      case "mt":      return new MTBridgeAdapter();
      default:        return new PaperAdapter(this.paperLedger);
    }
  }

  async execute(signal) {
    if (!signal.meta?.isTradeworthy) {
      return { skipped: true, reason: "Signal below quality threshold" };
    }

    const order = this.buildOrder(signal);
    console.log(`[Broker] Executing ${order.side} ${order.symbol} @ ${order.entry}`);

    try {
      const result = await this.adapter.placeOrder(order);
      return { success: true, orderId: result.id, order, result };
    } catch (err) {
      return { success: false, error: err.message, order };
    }
  }

  buildOrder(signal) {
    return {
      symbol:     signal.meta.asset,
      side:       signal.verdict,
      entry:      signal.entry,
      stopLoss:   signal.stop_loss,
      takeProfit: signal.take_profit,
      size:       signal.meta.positionSize,
      riskAmount: signal.meta.riskAmount,
      grade:      signal.meta.grade,
      confidence: signal.confidence,
      timestamp:  new Date().toISOString(),
    };
  }
}

// ─── PAPER TRADING (default) ─────────────────────────────────────────────────

class PaperAdapter {
  constructor(ledger) {
    this.ledger = ledger;
  }

  async placeOrder(order) {
    const id = `PAPER-${Date.now()}`;
    this.ledger.push({ id, ...order, status: "open" });
    console.log(`[Paper] Order placed: ${id}`);
    console.log(`  ${order.side} ${order.symbol} | Entry: ${order.entry} | SL: ${order.stopLoss} | TP: ${order.takeProfit}`);
    return { id };
  }
}

// ─── DERIV (Binary.com) ───────────────────────────────────────────────────────

class DerivAdapter {
  constructor() {
    this.appId = process.env.DERIV_APP_ID;
    this.token = process.env.DERIV_API_TOKEN;
    if (!this.appId || !this.token) {
      throw new Error("DERIV_APP_ID and DERIV_API_TOKEN required for Deriv broker");
    }
  }

  async placeOrder(order) {
    // Deriv WebSocket API
    // Docs: https://api.deriv.com/
    // Real implementation: open WSocket to wss://ws.binaryws.com/websockets/v3
    // Send: { buy: 1, price: riskAmount, parameters: { contract_type, symbol, duration, ... } }
    throw new Error("Deriv adapter: implement WebSocket connection to wss://ws.binaryws.com/websockets/v3");
  }
}

// ─── OANDA ───────────────────────────────────────────────────────────────────

class OandaAdapter {
  constructor() {
    this.apiKey    = process.env.OANDA_API_KEY;
    this.accountId = process.env.OANDA_ACCOUNT_ID;
    this.baseUrl   = process.env.OANDA_PRACTICE === "true"
      ? "https://api-fxpractice.oanda.com"
      : "https://api-fxtrade.oanda.com";

    if (!this.apiKey || !this.accountId) {
      throw new Error("OANDA_API_KEY and OANDA_ACCOUNT_ID required");
    }
  }

  async placeOrder(order) {
    const side = order.side === "BUY" ? 1 : -1;
    const units = Math.floor(parseFloat(order.size || 1000) * side);

    const body = {
      order: {
        type: "MARKET",
        instrument: order.symbol.replace("/", "_"),
        units: String(units),
        stopLossOnFill:   { price: String(parseFloat(order.stopLoss).toFixed(5)) },
        takeProfitOnFill: { price: String(parseFloat(order.takeProfit).toFixed(5)) },
        timeInForce: "FOK",
      },
    };

    const res = await fetch(`${this.baseUrl}/v3/accounts/${this.accountId}/orders`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OANDA error: ${err}`);
    }

    const data = await res.json();
    return { id: data.orderCreateTransaction?.id || "unknown" };
  }
}

// ─── BINANCE FUTURES ──────────────────────────────────────────────────────────

class BinanceAdapter {
  constructor() {
    this.apiKey    = process.env.BINANCE_API_KEY;
    this.apiSecret = process.env.BINANCE_API_SECRET;
    this.baseUrl   = process.env.BINANCE_TESTNET === "true"
      ? "https://testnet.binancefuture.com"
      : "https://fapi.binance.com";

    if (!this.apiKey || !this.apiSecret) {
      throw new Error("BINANCE_API_KEY and BINANCE_API_SECRET required");
    }
  }

  async placeOrder(order) {
    // Real implementation needs HMAC-SHA256 signature
    // Docs: https://binance-docs.github.io/apidocs/futures/en/
    const params = new URLSearchParams({
      symbol:      order.symbol.replace("/", "").replace("-", ""),
      side:        order.side,
      type:        "MARKET",
      quantity:    parseFloat(order.size || 0.001).toFixed(3),
      timestamp:   Date.now(),
      stopPrice:   order.stopLoss,
    });

    // TODO: sign params with HMAC-SHA256 using apiSecret
    throw new Error("Binance adapter: add HMAC-SHA256 signing before using in production");
  }
}

// ─── METATRADER BRIDGE ────────────────────────────────────────────────────────

class MTBridgeAdapter {
  constructor() {
    // Requires mt5_bridge/server.py running locally
    // Start it with: python mt5_bridge/server.py
    this.bridgeUrl = process.env.MT_BRIDGE_URL    || "http://127.0.0.1:15555";
    this.secret    = process.env.MT5_BRIDGE_SECRET || "";
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.secret) h["X-Secret"] = this.secret;
    return h;
  }

  async placeOrder(order) {
    // Parse actual price levels from the signal strings
    // e.g. "2313.00 — below demand zone" → 2313.00
    const sl = parseFloat(order.stopLoss)   || 0;
    const tp = parseFloat(order.takeProfit) || 0;

    const body = {
      symbol:      order.symbol,
      side:        order.side,           // "BUY" or "SELL"
      sl,
      tp,
      risk_amount: order.riskAmount,     // dollar amount to risk — bridge calculates lots
      comment:     `TraderBot ${order.grade} ${order.confidence}%`,
      filling_mode: "IOC",           // Immediate or Cancel - more compatible with demo accounts
      type:        "MARKET",          // Use market orders first, then modify with SL/TP
    };

    const res = await fetch(`${this.bridgeUrl}/execute`, {
      method:  "POST",
      headers: this._headers(),
      body:    JSON.stringify(body),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `MT Bridge error ${res.status}`);
    return { id: data.order_id, ...data };
  }

  async getPositions() {
    const res = await fetch(`${this.bridgeUrl}/positions`, { headers: this._headers() });
    return res.json();
  }

  async getAccount() {
    const res = await fetch(`${this.bridgeUrl}/account`, { headers: this._headers() });
    return res.json();
  }

  async closePosition(ticket) {
    const res = await fetch(`${this.bridgeUrl}/close/${ticket}`, {
      method:  "POST",
      headers: this._headers(),
    });
    return res.json();
  }
}
