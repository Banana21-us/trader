/**
 * Single source of truth for runtime configuration.
 * Validated at boot — a bad config fails loudly here rather than
 * silently mis-sizing a position three hours into a live session.
 */

const MODES   = ["backtest", "paper", "testnet", "live"];
const MARKETS = ["spot", "futures"];

function req(name, value) {
  if (value === undefined || value === null || value === "") {
    throw new Error(`Config error: ${name} is required but not set`);
  }
  return value;
}

function num(name, raw, { min = -Infinity, max = Infinity, fallback } = {}) {
  const v = raw === undefined || raw === "" ? fallback : Number(raw);
  if (v === undefined) throw new Error(`Config error: ${name} is required`);
  if (!Number.isFinite(v)) throw new Error(`Config error: ${name}="${raw}" is not a number`);
  if (v < min || v > max) throw new Error(`Config error: ${name}=${v} outside allowed range [${min}, ${max}]`);
  return v;
}

function oneOf(name, raw, allowed, fallback) {
  const v = (raw || fallback || "").toLowerCase();
  if (!allowed.includes(v)) {
    throw new Error(`Config error: ${name}="${raw}" must be one of: ${allowed.join(", ")}`);
  }
  return v;
}

function list(raw, fallback = []) {
  if (!raw) return fallback;
  return raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

function bool(raw, fallback = false) {
  if (raw === undefined || raw === "") return fallback;
  return raw === "true" || raw === "1" || raw === "yes";
}

export function loadConfig(env = process.env) {
  const mode   = oneOf("MODE",   env.MODE,   MODES,   "paper");
  const market = oneOf("MARKET", env.MARKET, MARKETS, "spot");

  const live = mode === "live";

  // Live trading demands credentials up front — discovering they're missing
  // after a signal fires means a missed entry or a half-managed position.
  if (live || mode === "testnet") {
    req("BINANCE_API_KEY",    env.BINANCE_API_KEY);
    req("BINANCE_API_SECRET", env.BINANCE_API_SECRET);
  }

  const cfg = {
    mode,
    market,
    isLive:     live,
    isTestnet:  mode === "testnet",
    isBacktest: mode === "backtest",

    binance: {
      apiKey:    env.BINANCE_API_KEY    || "",
      apiSecret: env.BINANCE_API_SECRET || "",
      testnet:   mode === "testnet",
      recvWindow: num("BINANCE_RECV_WINDOW", env.BINANCE_RECV_WINDOW, { min: 1000, max: 60000, fallback: 5000 }),
    },

    capital: {
      // Equity is read from the exchange when live; this is the backtest/paper seed.
      startingEquity: num("STARTING_EQUITY", env.STARTING_EQUITY, { min: 10, fallback: 500 }),
      riskPctPerTrade: num("RISK_PCT", env.RISK_PCT, { min: 0.1, max: 5, fallback: 1 }),
      maxLeverage:     num("MAX_LEVERAGE", env.MAX_LEVERAGE, { min: 1, max: 20, fallback: market === "futures" ? 3 : 1 }),
    },

    risk: {
      maxConcurrentPositions: num("MAX_POSITIONS", env.MAX_POSITIONS, { min: 1, max: 10, fallback: 3 }),
      maxDailyLossPct:   num("MAX_DAILY_LOSS_PCT", env.MAX_DAILY_LOSS_PCT, { min: 0.5, max: 20, fallback: 3 }),
      maxTotalDrawdownPct: num("MAX_DD_PCT", env.MAX_DD_PCT, { min: 1, max: 50, fallback: 15 }),
      maxConsecutiveLosses: num("MAX_CONSEC_LOSSES", env.MAX_CONSEC_LOSSES, { min: 2, max: 20, fallback: 4 }),
      lossCooldownHours: num("LOSS_COOLDOWN_H", env.LOSS_COOLDOWN_H, { min: 0, max: 168, fallback: 6 }),
      // Two positions in assets this correlated count as one bet for exposure purposes.
      correlationThreshold: num("CORRELATION_THRESHOLD", env.CORRELATION_THRESHOLD, { min: 0.1, max: 1, fallback: 0.7 }),
      maxPortfolioHeatPct: num("MAX_HEAT_PCT", env.MAX_HEAT_PCT, { min: 0.5, max: 25, fallback: 6 }),
    },

    universe: {
      // Candidate pool the screener ranks each cycle. Not all get traded.
      candidates: list(env.UNIVERSE, ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"]),
      maxDeepAnalysis: num("MAX_DEEP_ANALYSIS", env.MAX_DEEP_ANALYSIS, { min: 1, max: 10, fallback: 3 }),
      minQuoteVolume24h: num("MIN_QUOTE_VOL", env.MIN_QUOTE_VOL, { min: 0, fallback: 50_000_000 }),
    },

    timeframes: {
      entry:   env.TF_ENTRY   || "15m",
      context: env.TF_CONTEXT || "4h",
      bias:    env.TF_BIAS    || "1d",
    },

    ai: {
      // Layer 2 defaults to the strongest model — the deep-analysis step is
      // where reasoning quality actually moves the needle. Step down via env
      // once attribution shows whether the depth pays for itself.
      analystModel: env.ANALYST_MODEL || "claude-opus-5",
      triageModel:  env.TRIAGE_MODEL  || "claude-haiku-4-5",
      redTeamModel: env.REDTEAM_MODEL || "claude-sonnet-5",
      reviewModel:  env.REVIEW_MODEL  || "claude-opus-5",
      analystEffort: oneOf("ANALYST_EFFORT", env.ANALYST_EFFORT, ["low","medium","high","xhigh","max"], "high"),
      enabled: bool(env.AI_ENABLED, true),
      monthlyBudgetUsd: num("AI_BUDGET_USD", env.AI_BUDGET_USD, { min: 0, fallback: 25 }),
    },

    intel: {
      newsEnabled:   bool(env.NEWS_ENABLED, true),
      socialEnabled: bool(env.SOCIAL_ENABLED, true),
      // A source earns influence through resolved sample size, not elapsed days.
      minResolvedCalls: num("SOURCE_MIN_CALLS", env.SOURCE_MIN_CALLS, { min: 10, fallback: 30 }),
      minWilsonLowerBound: num("SOURCE_MIN_WILSON", env.SOURCE_MIN_WILSON, { min: 0.3, max: 0.9, fallback: 0.5 }),
      resolveHorizonHours: num("SOURCE_HORIZON_H", env.SOURCE_HORIZON_H, { min: 1, max: 336, fallback: 24 }),
    },

    costs: {
      // Backtests that ignore these produce fiction.
      takerFeeBps: num("TAKER_FEE_BPS", env.TAKER_FEE_BPS, { min: 0, fallback: market === "futures" ? 4.5 : 10 }),
      makerFeeBps: num("MAKER_FEE_BPS", env.MAKER_FEE_BPS, { min: 0, fallback: market === "futures" ? 1.8 : 10 }),
      slippageBps: num("SLIPPAGE_BPS", env.SLIPPAGE_BPS, { min: 0, fallback: 5 }),
    },

    paths: {
      db: env.DB_PATH || "./data/trader.db",
    },

    telegram: {
      enabled:  bool(env.TELEGRAM_ENABLED, !!env.TELEGRAM_BOT_TOKEN),
      botToken: env.TELEGRAM_BOT_TOKEN || "",
      chatId:   env.TELEGRAM_CHAT_ID   || "",
    },
  };

  if (cfg.market === "spot" && cfg.capital.maxLeverage > 1) {
    throw new Error("Config error: MAX_LEVERAGE must be 1 for spot market");
  }

  return Object.freeze(cfg);
}

export function describeConfig(cfg) {
  return [
    `mode=${cfg.mode}`,
    `market=${cfg.market}`,
    `universe=${cfg.universe.candidates.join("/")}`,
    `risk=${cfg.capital.riskPctPerTrade}%/trade`,
    `maxDD=${cfg.risk.maxTotalDrawdownPct}%`,
    `analyst=${cfg.ai.analystModel}@${cfg.ai.analystEffort}`,
  ].join("  ");
}
