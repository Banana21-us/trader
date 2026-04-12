# CLAUDE.md

## Project: AI Trader Bot

Claude-powered trade signal analyzer. Uses multi-model consensus (trend + S/R + momentum) on chart screenshots to generate buy/sell signals with position sizing.

## Architecture

- **Entry**: `src/index.js` — CLI with interactive and flag modes
- **Core**: `src/trader.js` — `TraderBot` class, orchestrates everything
- **Brain**: `src/prompts/system.js` — full trader system prompt (DO NOT simplify)
- **Prompts**: `src/prompts/analysis.js` — per-request prompt builders
- **Risk**: `src/utils/risk.js` — position sizing, signal grading, report formatting
- **Logs**: `src/utils/logger.js` — JSONL signal logs in `./logs/`

## Key Conventions

- Model: `claude-opus-4-5` for best vision + reasoning on charts
- Always send system prompt via `system:` field, not in messages
- Images sent as base64 before the analysis text prompt
- Response is always raw JSON — no markdown fences
- `RiskEngine.enrich()` adds `meta` block with calculated values
- Signals are graded A+/A/B/C/skip based on confidence + R:R

## Running

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm install
node src/index.js
```

## Extending

To add broker execution: import signal from `trader.analyze()`, check `signal.meta.isTradeworthy`, then call your broker API with `signal.entry`, `signal.stop_loss`, `signal.take_profit`.

To add news feed: call `buildNewsPrompt()` from `prompts/analysis.js` with scraped headlines before the main analysis, inject sentiment into the `news` param.

To add Telegram alerts: wrap `riskEngine.formatReport()` output and send via `node-telegram-bot-api` when `signal.meta.grade === 'A+' || 'A'`.
