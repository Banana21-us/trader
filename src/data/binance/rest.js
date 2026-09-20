/**
 * Binance public market data.
 *
 * Every endpoint here is unauthenticated — no API key, no secret, no account.
 * That matters at this account size: the data that actually moves the needle
 * costs nothing, while the LLM layer that costs $12-20/month is the part with
 * unproven value.
 *
 * Positioning endpoints (funding, open interest, long/short ratio) are the
 * honest version of "community sentiment": they are what the crowd has
 * actually DONE with money, sampled every 5 minutes, rather than what it says
 * on a forum. Prefer them over scraped opinion.
 */

const SPOT    = "https://api.binance.com";
const FUTURES = "https://fapi.binance.com";

export class BinanceRest {
  constructor({ market = "spot", timeoutMs = 10_000, minIntervalMs = 120 } = {}) {
    this.market    = market;
    this.timeoutMs = timeoutMs;
    this.minIntervalMs = minIntervalMs;
    this._lastCall = 0;
  }

  get base() { return this.market === "futures" ? FUTURES : SPOT; }

  async _get(path, params = {}, { base } = {}) {
    // Crude client-side pacing. Binance bans on weight, and a backfill loop
    // will trip it long before a human notices.
    const wait = this.minIntervalMs - (Date.now() - this._lastCall);
    if (wait > 0) await sleep(wait);
    this._lastCall = Date.now();

    const url = new URL(path, base || this.base);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.status === 429 || res.status === 418) {
        throw new Error(`Binance rate limit (${res.status}) on ${path} — back off`);
      }
      if (!res.ok) {
        throw new Error(`Binance ${res.status} on ${path}: ${(await res.text()).slice(0, 200)}`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // ── CANDLES ───────────────────────────────────────────────────────────────

  /** Raw klines. `limit` max 1000 per call. */
  async klines(symbol, interval, { limit = 500, startTime, endTime } = {}) {
    const path = this.market === "futures" ? "/fapi/v1/klines" : "/api/v3/klines";
    const rows = await this._get(path, { symbol, interval, limit, startTime, endTime });
    return rows.map(normaliseKline);
  }

  /**
   * Backfill history by paging forward from `sinceMs`.
   * Only closed candles are returned — an open candle has no final high, low
   * or close, and feeding one to a backtest is look-ahead bias.
   */
  async klineHistory(symbol, interval, { sinceMs, untilMs = Date.now(), maxCandles = 10_000 } = {}) {
    const out = [];
    let cursor = sinceMs;

    while (cursor < untilMs && out.length < maxCandles) {
      const batch = await this.klines(symbol, interval, {
        limit: 1000, startTime: cursor, endTime: untilMs,
      });
      if (batch.length === 0) break;

      for (const c of batch) if (c.closed) out.push(c);

      const last = batch.at(-1);
      if (last.openTime <= cursor) break;
      cursor = last.openTime + 1;

      if (batch.length < 1000) break;
    }
    return out.slice(0, maxCandles);
  }

  // ── SCREENING ─────────────────────────────────────────────────────────────

  async ticker24h(symbol) {
    const path = this.market === "futures" ? "/fapi/v1/ticker/24hr" : "/api/v3/ticker/24hr";
    return this._get(path, symbol ? { symbol } : {});
  }

  /** Liquidity filter. Thin books turn a good signal into a bad fill. */
  async liquidUniverse({ quote = "USDT", minQuoteVolume = 50_000_000 } = {}) {
    const all = await this.ticker24h();
    return all
      .filter((t) => t.symbol.endsWith(quote))
      .filter((t) => parseFloat(t.quoteVolume) >= minQuoteVolume)
      .map((t) => ({
        symbol: t.symbol,
        quoteVolume: parseFloat(t.quoteVolume),
        priceChangePct: parseFloat(t.priceChangePercent),
        lastPrice: parseFloat(t.lastPrice),
      }))
      .sort((a, b) => b.quoteVolume - a.quoteVolume);
  }

  // ── EXCHANGE RULES ────────────────────────────────────────────────────────

  /**
   * Tick size, step size and minimum notional. An order that ignores these is
   * rejected by the exchange, which at 3am looks exactly like a missed trade.
   */
  async symbolFilters(symbol) {
    const path = this.market === "futures" ? "/fapi/v1/exchangeInfo" : "/api/v3/exchangeInfo";
    const info = await this._get(path, { symbol });
    const s = info.symbols?.find((x) => x.symbol === symbol);
    if (!s) throw new Error(`Symbol ${symbol} not listed on ${this.market}`);

    const f = (type) => s.filters.find((x) => x.filterType === type) || {};
    return {
      symbol,
      status: s.status,
      baseAsset: s.baseAsset,
      quoteAsset: s.quoteAsset,
      tickSize: parseFloat(f("PRICE_FILTER").tickSize ?? 0),
      stepSize: parseFloat(f("LOT_SIZE").stepSize ?? 0),
      minQty:   parseFloat(f("LOT_SIZE").minQty ?? 0),
      minNotional: parseFloat(
        f("MIN_NOTIONAL").minNotional ?? f("NOTIONAL").minNotional ?? 0
      ),
    };
  }

  // ── POSITIONING (futures only) ────────────────────────────────────────────

  /** Funding rate history. Persistently positive = crowded long, paying to hold. */
  async fundingRate(symbol, { limit = 100, startTime, endTime } = {}) {
    const rows = await this._get("/fapi/v1/fundingRate",
      { symbol, limit, startTime, endTime }, { base: FUTURES });
    return rows.map((r) => ({
      symbol: r.symbol,
      ts: Number(r.fundingTime),
      rate: parseFloat(r.fundingRate),
    }));
  }

  async openInterestHist(symbol, period = "5m", limit = 100) {
    const rows = await this._get("/futures/data/openInterestHist",
      { symbol, period, limit }, { base: FUTURES });
    return rows.map((r) => ({
      ts: Number(r.timestamp),
      openInterest: parseFloat(r.sumOpenInterest),
      notional: parseFloat(r.sumOpenInterestValue),
    }));
  }

  /** Retail account long/short ratio — the crowd's actual book. */
  async longShortRatio(symbol, period = "5m", limit = 100) {
    const rows = await this._get("/futures/data/globalLongShortAccountRatio",
      { symbol, period, limit }, { base: FUTURES });
    return rows.map((r) => ({
      ts: Number(r.timestamp),
      longShortRatio: parseFloat(r.longShortRatio),
      longPct: parseFloat(r.longAccount),
      shortPct: parseFloat(r.shortAccount),
    }));
  }

  /** Large-account ratio. Divergence from retail is the interesting part. */
  async topTraderRatio(symbol, period = "5m", limit = 100) {
    const rows = await this._get("/futures/data/topLongShortAccountRatio",
      { symbol, period, limit }, { base: FUTURES });
    return rows.map((r) => ({
      ts: Number(r.timestamp),
      longShortRatio: parseFloat(r.longShortRatio),
      longPct: parseFloat(r.longAccount),
      shortPct: parseFloat(r.shortAccount),
    }));
  }
}

function normaliseKline(k) {
  return {
    openTime:  Number(k[0]),
    open:      parseFloat(k[1]),
    high:      parseFloat(k[2]),
    low:       parseFloat(k[3]),
    close:     parseFloat(k[4]),
    volume:    parseFloat(k[5]),
    closeTime: Number(k[6]),
    quoteVol:  parseFloat(k[7]),
    trades:    Number(k[8]),
    closed:    Number(k[6]) < Date.now(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
