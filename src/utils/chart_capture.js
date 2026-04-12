/**
 * Chart Capture — Auto TradingView Screenshot
 *
 * Opens a headless browser, navigates to TradingView for each timeframe,
 * waits for candles to fully render, then saves the screenshot.
 *
 * The watch.js loop calls captureAsset(symbol) before every analysis so
 * Claude always gets real, current chart images — enabling A+ signals.
 *
 * First-time setup:
 *   npx playwright install chromium
 */

import { chromium } from "playwright";
import fs from "fs";
import path from "path";

// Map internal asset names → TradingView symbols
const TV_SYMBOLS = {
  XAUUSD:  "OANDA:XAUUSD",
  BTCUSDT: "BINANCE:BTCUSDT",
  EURUSD:  "OANDA:EURUSD",
  GBPUSD:  "OANDA:GBPUSD",
  USDJPY:  "OANDA:USDJPY",
  NASDAQ:  "NASDAQ:QQQ",
  SP500:   "AMEX:SPY",
  US30:    "FOREXCOM:DJI",
};

// Timeframe codes for TradingView URLs
const TIMEFRAMES = {
  daily: "D",
  m15:   "15",
  m5:    "5",
};

// Studies to add to every chart (EMA 20/50/200 + Volume)
// These help Claude identify trend direction and structure
const STUDIES = encodeURIComponent(JSON.stringify([
  "MAExp@tv-basicstudies",   // EMA 20
  "MAExp@tv-basicstudies",   // EMA 50
  "MAExp@tv-basicstudies",   // EMA 200
  "Volume@tv-basicstudies",
]));

export class ChartCapture {
  constructor() {
    this.browser = null;
  }

  // ── BROWSER LIFECYCLE ────────────────────────────────────────────────────

  async _ensureBrowser() {
    if (this.browser) {
      try {
        // Check still alive
        await this.browser.contexts();
        return;
      } catch {
        this.browser = null;
      }
    }

    console.log("[Charts] Launching headless browser...");
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
      ],
    });
  }

  async close() {
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  // ── CAPTURE ALL TIMEFRAMES FOR ONE ASSET ─────────────────────────────────

  async captureAsset(asset) {
    const tvSymbol = TV_SYMBOLS[asset] || asset;
    const charts   = {};

    await this._ensureBrowser();

    for (const [name, interval] of Object.entries(TIMEFRAMES)) {
      try {
        const file = await this._captureOne(tvSymbol, interval, asset, name);
        if (file) charts[name] = file;
      } catch (err) {
        console.warn(`[Charts] ✗ ${asset} ${name}: ${err.message}`);
      }
    }

    const count = Object.keys(charts).length;
    if (count > 0) {
      console.log(`[Charts] ✓ ${asset} — ${count}/3 charts captured`);
    } else {
      console.warn(`[Charts] ✗ ${asset} — no charts captured (Playwright installed?)`);
    }

    return charts;
  }

  // ── CAPTURE ONE CHART ─────────────────────────────────────────────────────

  async _captureOne(tvSymbol, interval, asset, name) {
    const ctx  = await this.browser.newContext({
      viewport:  { width: 1440, height: 900 },
      // Appear as a real browser to avoid bot detection
      userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });

    const page = await ctx.newPage();

    try {
      const url =
        `https://www.tradingview.com/chart/` +
        `?symbol=${tvSymbol}` +
        `&interval=${interval}` +
        `&theme=dark` +
        `&style=1` +          // candlestick
        `&hide_side_toolbar=0` +
        `&save_image=false`;

      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40_000 });

      // ── Dismiss overlays ──────────────────────────────────────────────

      // Cookie consent (EU)
      await this._dismiss(page, '[data-name="cookie-policy-accept"]');

      // "Sign in to unlock" modal or any close button
      await this._dismiss(page, '[data-name="close-button"]');
      await this._dismiss(page, "button.close-B02UUUN3");

      // Press Escape to close any remaining modal
      await page.keyboard.press("Escape").catch(() => {});

      // ── Wait for chart to fully render ────────────────────────────────

      // Wait for canvas elements (the actual chart is drawn on canvas)
      await page.waitForSelector("canvas", { timeout: 25_000 });

      // Give candles time to paint — more on Daily (more data)
      const waitMs = interval === "D" ? 5000 : 4000;
      await page.waitForTimeout(waitMs);

      // ── Screenshot ────────────────────────────────────────────────────

      // Clip to chart area — skip the top toolbar (≈55px) and side panels
      const clip = { x: 56, y: 55, width: 1300, height: 780 };

      if (!fs.existsSync("screenshots")) fs.mkdirSync("screenshots");
      const filePath = path.resolve(`screenshots/${asset}-${name}.png`);

      await page.screenshot({ path: filePath, clip });
      return filePath;

    } finally {
      await ctx.close().catch(() => {});
    }
  }

  // ── HELPER: click a selector if it exists ────────────────────────────────

  async _dismiss(page, selector, timeout = 2500) {
    try {
      await page.click(selector, { timeout });
    } catch {
      // Not present — that's fine
    }
  }
}
