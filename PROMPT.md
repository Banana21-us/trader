# AI Trader Bot — Full Project Context Prompt

Use this to onboard any AI assistant or new developer to this codebase instantly.

---

## What This Is

A Node.js CLI bot powered by Claude claude-opus-4-5 (Anthropic) that analyzes trading chart screenshots and returns professional buy/sell signals with full risk calculations. It uses a **multi-model consensus system** — three internal analysis models (Trend, S/R, Momentum) must agree before a signal is graded high-quality.

---

## How It Works (End to End)

1. User drops chart screenshots into `screenshots/` (Daily, 15min, 5min timeframes)
2. `src/index.js` collects inputs (asset, balance, risk %, news context, chart paths)
3. `src/trader.js` (`TraderBot.analyze()`) encodes the images as base64 and builds a message
4. The message is sent to Claude claude-opus-4-5 with a detailed system prompt (the trader brain)
5. Claude returns raw JSON — a trade signal with verdict, entry, stop loss, take profit, model votes
6. `src/utils/risk.js` (`RiskEngine.enrich()`) adds position sizing, pip risk, grade, and a `meta` block
7. The enriched signal is printed as a formatted report and logged to `logs/signals-YYYY-MM-DD.jsonl`

---

## Project Structure

```
trader-bot/
├── src/
│   ├── index.js          — CLI entry: interactive mode + --flag mode
│   ├── trader.js         — TraderBot class: orchestrates everything
│   ├── watch.js          — Scheduled scanner: scans multiple assets on interval
│   ├── webhook.js        — TradingView webhook server (HTTP POST → analyze → alert)
│   ├── journal.js        — Trade journal CLI: view signals, mark win/loss, stats
│   ├── prompts/
│   │   ├── system.js     — THE BRAIN: full trader system prompt sent to Claude
│   │   └── analysis.js   — Per-request prompt builders (analysis + news + refinement)
│   ├── models/
│   │   ├── trend.js      — Trend model stub (HTF bias, EMA alignment, market structure)
│   │   ├── sr.js         — Support/Resistance model stub (key levels, order blocks, FVGs)
│   │   └── momentum.js   — Momentum model stub (candle patterns, breakouts, divergence)
│   └── utils/
│       ├── risk.js       — RiskEngine: position sizing, signal grading (A+/A/B/C/skip), report formatter
│       ├── logger.js     — JSONL signal logger + win rate tracker
│       ├── broker.js     — Broker adapters: Paper / OANDA / Binance / Deriv / MetaTrader
│       ├── telegram.js   — Telegram alerter with inline ✅ EXECUTE / ❌ SKIP buttons
│       └── news.js       — RSS news fetcher + Claude Haiku sentiment analyzer
├── screenshots/          — Drop PNG/JPG chart images here
├── logs/                 — Auto-created. One JSONL file per day
├── package.json          — type: module, @anthropic-ai/sdk dependency
├── .env.example          — All supported environment variables
├── CLAUDE.md             — Context file for Claude Code (not the bot brain)
└── README.md             — Setup and usage docs
```

---

## The Brain (`src/prompts/system.js`)

This is the system prompt sent to Claude with every analysis. It defines:

- **Trading philosophy**: top-down multi-timeframe analysis (Daily → 15min → 5min)
- **Three analysis models** Claude runs internally:
  - **Trend Model**: market structure (HH/HL or LH/LL), EMA alignment, HTF bias
  - **S/R Model**: support/resistance levels, order blocks, Fair Value Gaps, confluence zones
  - **Momentum Model**: candle patterns (engulfing, pin bar, hammer), breakout vs fakeout
- **Trade rules**: minimum 1:2 R:R, 2-of-3 model agreement required, never fight Daily trend
- **Output format**: strict raw JSON — no markdown, no explanation, just the signal object

---

## Signal JSON Shape

```json
{
  "verdict": "BUY",
  "confidence": 82,
  "summary": "Strong bullish confluence at 2318 demand zone",
  "trend_vote": "BUY", "trend_conf": 85, "trend_note": "HTF uptrend intact",
  "sr_vote": "BUY",    "sr_conf": 80,    "sr_note": "Clean demand zone at 2318-2320",
  "momentum_vote": "BUY", "momentum_conf": 78, "momentum_note": "Bullish engulfing on 5min",
  "entry": "2319.50 - 2321.00",
  "stop_loss": "2313.00 — below demand zone",
  "take_profit": "2345.00",
  "tp2": "2360.00",
  "rr_ratio": "1:3.8",
  "key_levels": "2313, 2318, 2345, 2360",
  "reasoning": "3-4 sentence professional trader breakdown...",
  "invalidation": "4H close below 2313",
  "trade_quality": "A",
  "meta": {
    "asset": "XAUUSD",
    "balance": 5000,
    "riskPct": 2,
    "riskAmount": 100,
    "maxReward": 380,
    "positionSize": "14.9254",
    "pipRisk": 6.5,
    "rrNum": 3.8,
    "grade": "A",
    "isTradeworthy": true,
    "timestamp": "2026-04-12T10:30:00.000Z",
    "session": "London open"
  }
}
```

---

## Signal Grading (`src/utils/risk.js`)

| Grade | Confidence | R:R  | All 3 models agree |
|-------|-----------|------|--------------------|
| A+    | ≥ 80%     | ≥ 3  | Yes                |
| A     | ≥ 75%     | ≥ 2.5| —                  |
| B     | ≥ 65%     | ≥ 2  | —                  |
| C     | ≥ 55%     | ≥ 1.5| —                  |
| skip  | < 55%     | < 1.5| —                  |

A signal is **tradeable** (`isTradeworthy: true`) when: verdict ≠ NEUTRAL AND confidence ≥ 65% AND R:R ≥ 2.0.

---

## Running Modes

```bash
# Interactive mode (prompts you for inputs)
node src/index.js

# One-shot CLI with chart screenshots
node src/index.js --asset XAUUSD --balance 5000 --risk 2 \
  --news "Fed hawkish, CPI beat" \
  --daily ./screenshots/xau-daily.png \
  --m15   ./screenshots/xau-15m.png \
  --m5    ./screenshots/xau-5m.png

# Scheduled watcher — scans assets every N minutes, sends Telegram alerts
node src/watch.js

# TradingView webhook server — receives alerts, runs analysis, sends Telegram
node src/webhook.js

# Trade journal
node src/journal.js --stats
node src/journal.js --win 1712920800
node src/journal.js --loss 1712920800
node src/journal.js --grade A+
```

---

## Broker Execution

Set `BROKER=paper|oanda|binance|deriv|mt` in `.env`.  
Default is `paper` — logs orders to memory, no real trades.  
Real adapters are in `src/utils/broker.js` — OANDA is fully implemented, Binance needs HMAC signing, Deriv needs WebSocket.

## Telegram Alerts

Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in `.env`.  
Signals arrive on your phone with **[✅ EXECUTE] [❌ SKIP]** inline buttons.  
Tapping EXECUTE calls the broker adapter and confirms the order ID back to you.

---

## Key Environment Variables

```
ANTHROPIC_API_KEY=       # Required — your Anthropic key
ASSET=XAUUSD             # Default asset
BALANCE=1000             # Account balance in USD
RISK_PCT=2               # Risk % per trade
TELEGRAM_BOT_TOKEN=      # Telegram bot token
TELEGRAM_CHAT_ID=        # Your Telegram chat ID
BROKER=paper             # paper | oanda | binance | deriv | mt
AUTO_EXECUTE=false        # true = skip YES/NO, fire immediately
WATCH_ASSETS=XAUUSD,BTCUSDT,EURUSD
WATCH_INTERVAL_MIN=15
MIN_GRADE=A              # Minimum grade to send Telegram alert
WEBHOOK_PORT=3001
WEBHOOK_SECRET=          # Secret token for TradingView webhook
```

---

## Extending

- **Add broker**: implement `placeOrder(order)` as a new class in `src/utils/broker.js`, add a case in `createAdapter()`
- **Add news source**: add RSS URL to `getFeedsForAsset()` in `src/utils/news.js`
- **Change trading style**: edit the system prompt in `src/prompts/system.js`
- **Change output fields**: update the JSON schema in `system.js` and the `formatReport()` in `src/utils/risk.js`
- **Auto-execute on A+ only**: check `signal.meta.grade === 'A+'` before calling `broker.execute()`
