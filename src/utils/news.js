import Anthropic from "@anthropic-ai/sdk";
import { buildNewsPrompt } from "../prompts/analysis.js";

const client = new Anthropic();

const ASSET_KEYWORDS = {
  XAUUSD:  ["gold", "XAU", "XAUUSD", "precious metals", "Fed", "inflation", "safe haven"],
  BTCUSDT: ["bitcoin", "BTC", "crypto", "cryptocurrency", "SEC", "ETF", "halving"],
  EURUSD:  ["euro", "EUR", "ECB", "eurozone", "EURUSD"],
  GBPUSD:  ["pound", "GBP", "BOE", "Bank of England", "UK economy"],
  USDJPY:  ["yen", "JPY", "BOJ", "Bank of Japan", "carry trade"],
  NASDAQ:  ["nasdaq", "tech stocks", "QQQ", "big tech", "FAANG"],
  SP500:   ["S&P 500", "SPX", "SPY", "equities", "stock market"],
};

// Currency codes each asset is sensitive to — used for event filtering
const ASSET_CURRENCIES = {
  XAUUSD:  ["USD"],
  BTCUSDT: ["USD"],
  EURUSD:  ["USD", "EUR"],
  GBPUSD:  ["USD", "GBP"],
  USDJPY:  ["USD", "JPY"],
  USDCHF:  ["USD", "CHF"],
  AUDUSD:  ["USD", "AUD"],
  NASDAQ:  ["USD"],
  SP500:   ["USD"],
};

export class NewsFetcher {
  constructor() {
    this.cache = new Map();
    this.cacheTtlMs = 15 * 60 * 1000; // 15 minutes
    this.calendarCache = { data: null, ts: 0 };
    this.calendarTtlMs = 60 * 60 * 1000; // 1 hour
  }

  /**
   * Get high-impact economic events affecting this asset in the next `windowMinutes`.
   * Uses ForexFactory's free weekly calendar JSON.
   */
  async getUpcomingHighImpact(asset, windowMinutes = 30) {
    const events    = await this.fetchCalendar();
    const currencies = ASSET_CURRENCIES[asset] || ["USD"];
    const now       = Date.now();
    const horizon   = now + windowMinutes * 60 * 1000;

    return events
      .filter((e) => e.impact === "High")
      .filter((e) => currencies.includes(e.country))
      .filter((e) => e.timestamp >= now && e.timestamp <= horizon)
      .map((e) => ({
        title:        e.title,
        country:      e.country,
        time:         new Date(e.timestamp).toISOString(),
        minutesUntil: Math.round((e.timestamp - now) / 60_000),
      }))
      .sort((a, b) => a.minutesUntil - b.minutesUntil);
  }

  async fetchCalendar() {
    if (this.calendarCache.data && Date.now() - this.calendarCache.ts < this.calendarTtlMs) {
      return this.calendarCache.data;
    }

    try {
      const res  = await fetch("https://nfs.faireconomy.media/ff_calendar_thisweek.json", {
        headers: { "User-Agent": "TraderBot/1.0" },
      });
      const data = await res.json();

      const events = (Array.isArray(data) ? data : []).map((e) => ({
        title:     e.title,
        country:   e.country,
        impact:    e.impact,           // "High" | "Medium" | "Low" | "Holiday"
        timestamp: new Date(e.date).getTime(),
      })).filter((e) => !isNaN(e.timestamp));

      this.calendarCache = { data: events, ts: Date.now() };
      return events;
    } catch {
      return [];
    }
  }

  async getSentiment(asset) {
    const cacheKey = asset;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.ts < this.cacheTtlMs) {
      return cached.data;
    }

    const headlines = await this.fetchHeadlines(asset);
    if (!headlines.length) {
      return { sentiment: "NEUTRAL", strength: 30, key_drivers: "No recent news found.", risk_events: "none" };
    }

    const sentiment = await this.analyzeSentiment(asset, headlines);
    this.cache.set(cacheKey, { data: sentiment, ts: Date.now() });
    return sentiment;
  }

  async fetchHeadlines(asset) {
    // Uses free RSS feeds — no API key needed
    const feeds = this.getFeedsForAsset(asset);
    const headlines = [];

    for (const url of feeds) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "TraderBot/1.0" } });
        const text = await res.text();
        const titles = this.parseRssTitles(text).slice(0, 5);
        headlines.push(...titles);
      } catch {
        // Skip failed feeds
      }
    }

    return headlines.slice(0, 15);
  }

  parseRssTitles(xml) {
    const matches = xml.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/gs);
    const titles = [];
    for (const m of matches) {
      const t = (m[1] || m[2] || "").trim();
      if (t && t.length > 10 && !t.includes("<?xml")) titles.push(t);
    }
    return titles;
  }

  getFeedsForAsset(asset) {
    const base = [
      "https://feeds.feedburner.com/forexlive",
      "https://www.forexfactory.com/rss",
      "https://www.dailyfx.com/feeds/all",
    ];

    const assetFeeds = {
      BTCUSDT: ["https://cointelegraph.com/rss", "https://coindesk.com/arc/outboundfeeds/rss/"],
      XAUUSD:  ["https://www.kitco.com/rss/gold.xml"],
    };

    return [...base, ...(assetFeeds[asset] || [])];
  }

  async analyzeSentiment(asset, headlines) {
    const prompt = buildNewsPrompt({ asset, headlines });

    const res = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 300,
      system: "You analyze financial news sentiment. Respond only with raw JSON, no markdown.",
      messages: [{ role: "user", content: prompt }],
    });

    const raw = res.content.map((b) => b.text || "").join("").replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(raw);
    } catch {
      return { sentiment: "NEUTRAL", strength: 40, key_drivers: "Parse error.", risk_events: "none" };
    }
  }
}
