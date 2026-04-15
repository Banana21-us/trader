# AI Trader Bot

Claude-powered multi-model trade signal analyzer. Upload chart screenshots, get professional buy/sell signals with full risk calculations.

## Setup

```bash
npm install
export ANTHROPIC_API_KEY=your_key_here
```

## Usage

### Interactive mode (no args)
```bash
node src/index.js
```

### CLI with flags
```bash
# Quick signal — no charts
node src/index.js --asset XAUUSD --balance 5000 --risk 2

# Full analysis with screenshots
node src/index.js \
  --asset XAUUSD \
  --balance 5000 \
  --risk 2 \
  --news "Fed hawkish, CPI beat, dollar strong" \
  --daily ./screenshots/xau-daily.png \
  --m15   ./screenshots/xau-15m.png \
  --m5    ./screenshots/xau-5m.png
```

## Project Structure

```
trader-bot/
├── src/
│   ├── index.js          ← CLI entry point
│   ├── trader.js         ← Core TraderBot class
│   ├── prompts/
│   │   ├── system.js     ← Full trader system prompt (the brain)
│   │   └── analysis.js   ← Per-request prompt builders
│   ├── models/
│   │   ├── trend.js      ← Trend model
│   │   ├── sr.js         ← Support/resistance model
│   │   └── momentum.js   ← Momentum/pattern model
│   └── utils/
│       ├── risk.js       ← Position sizing + signal enrichment
│       └── logger.js     ← Signal logging + win rate tracking
├── screenshots/          ← Drop chart images here
├── logs/                 ← Auto-generated signal logs (JSONL)
└── package.json
```

## Signal Output

```
▲ VERDICT:     BUY (82% confidence) [A]
  Summary:     Strong bullish confluence at 2318 demand zone

─── MODEL VOTES ────────────────────────────────────
  Trend:       BUY (85%) — HTF uptrend intact, price above 200 EMA
  S/R:         BUY (80%) — Clean demand zone at 2318-2320
  Momentum:    BUY (78%) — Bullish engulfing on 5min with volume

─── TRADE LEVELS ───────────────────────────────────
  Entry:       2319.50 - 2321.00
  Stop Loss:   2313.00 (below demand zone)
  Take Profit: 2345.00 (next resistance)
  R:R Ratio:   1:3.8

─── RISK CALC ──────────────────────────────────────
  Balance:     $5,000
  Risk:        2% = $100
  Max Reward:  $380
  Position:    14.9254 units
```

## Signal Quality Grades

| Grade | Confidence | R:R | All models agree |
|-------|-----------|-----|-----------------|
| A+    | ≥80%      | ≥3  | Yes             |
| A     | ≥75%      | ≥2.5| -               |
| B     | ≥65%      | ≥2  | -               |
| C     | ≥55%      | ≥1.5| -               |
| skip  | <55%      | <1.5| -               |

## Environment Variables

```
ANTHROPIC_API_KEY=   Required
ASSET=               Default asset (XAUUSD)
BALANCE=             Default balance (1000)
RISK_PCT=            Default risk % (2)
```
"# trader" 
