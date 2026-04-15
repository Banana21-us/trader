import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenerativeAI } from "@google/generative-ai";
import fs from "fs";
import path from "path";
import { buildTraderSystemPrompt } from "./prompts/system.js";
import { buildAnalysisPrompt } from "./prompts/analysis.js";
import { TrendModel } from "./models/trend.js";
import { SRModel } from "./models/sr.js";
import { MomentumModel } from "./models/momentum.js";
import { RiskEngine } from "./utils/risk.js";
import { Logger } from "./utils/logger.js";

// Provider selection
const USE_FREE_MODEL = process.env.USE_FREE_MODEL === "true";
const USE_OLLAMA = process.env.USE_OLLAMA === "true";
const ANALYSIS_MODEL = process.env.ANALYSIS_MODEL || "claude-opus-4-5";
const GEMINI_MODEL   = process.env.GEMINI_MODEL   || "gemini-1.5-flash";
const OLLAMA_MODEL   = process.env.OLLAMA_MODEL   || "kimi-k2.5:cloud";
const OLLAMA_API_URL = process.env.OLLAMA_API_URL || "http://localhost:11434";

const claudeClient = new Anthropic();
const geminiClient = USE_FREE_MODEL && process.env.GEMINI_API_KEY
  ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY)
  : null;

export class TraderBot {
  constructor(config = {}) {
    this.config = {
      defaultAsset:    config.defaultAsset    || "XAUUSD",
      defaultBalance:  config.defaultBalance  || 1000,
      defaultRiskPct:  config.defaultRiskPct  || 2,
      minConfidence:   config.minConfidence   || 70,
      minRR:           config.minRR           || 2.0,
      ...config,
    };

    this.riskEngine = new RiskEngine();
    this.logger     = new Logger();
    this.models     = {
      trend:    new TrendModel(),
      sr:       new SRModel(),
      momentum: new MomentumModel(),
    };

    const provider = USE_OLLAMA ? `Ollama (${OLLAMA_MODEL})` : USE_FREE_MODEL ? `Gemini (${GEMINI_MODEL}) [FREE]` : `Claude (${ANALYSIS_MODEL})`;
    this.logger.info(`TraderBot initialized — provider: ${provider}`);
  }

  async analyze({ asset, balance, riskPct, session, news, charts = {} }) {
    const params = {
      asset:    asset    || this.config.defaultAsset,
      balance:  balance  || this.config.defaultBalance,
      riskPct:  riskPct  || this.config.defaultRiskPct,
      session:  session  || this.detectSession(),
      news:     news     || "No specific news context.",
      charts,
    };

    this.logger.info(`Analyzing ${params.asset} | Session: ${params.session}`);

    let signal;
    if (USE_OLLAMA) {
      signal = await this.runOllamaAnalysis(params);
    } else if (USE_FREE_MODEL) {
      signal = await this.runGeminiAnalysis(params);
    } else {
      const contentBlocks = this.buildClaudeContentBlocks(params);
      signal = await this.runClaudeAnalysis(contentBlocks);
    }

    const enriched = this.riskEngine.enrich(signal, params);
    this.logger.logSignal(enriched);
    return enriched;
  }

  // ── CLAUDE ANALYSIS ────────────────────────────────────────────────────────

  buildClaudeContentBlocks({ charts, asset, session, news, balance, riskPct }) {
    const blocks = [];

    if (charts.daily) {
      const img = this.loadImage(charts.daily);
      blocks.push(
        { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
        { type: "text", text: "DAILY chart — HTF trend bias and major S/R levels." }
      );
    }
    if (charts.m15) {
      const img = this.loadImage(charts.m15);
      blocks.push(
        { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
        { type: "text", text: "15-MINUTE chart — market structure and trade setup." }
      );
    }
    if (charts.m5) {
      const img = this.loadImage(charts.m5);
      blocks.push(
        { type: "image", source: { type: "base64", media_type: img.mimeType, data: img.data } },
        { type: "text", text: "5-MINUTE chart — entry trigger and candle patterns." }
      );
    }

    blocks.push({ type: "text", text: buildAnalysisPrompt({
      asset, session, news, balance, riskPct,
      hasCharts: blocks.length > 0,
    })});

    return blocks;
  }

  async runClaudeAnalysis(contentBlocks) {
    const useThinking = process.env.USE_THINKING === "true";

    const params = {
      model:      ANALYSIS_MODEL,
      max_tokens: useThinking ? 24000 : 1500,
      system:     buildTraderSystemPrompt(),
      messages:   [{ role: "user", content: contentBlocks }],
    };

    if (useThinking) {
      params.thinking = { type: "enabled", budget_tokens: 20000 };
    }

    const response = await claudeClient.messages.create(params);

    const raw   = response.content
      .filter((b) => b.type === "text")
      .map((b)   => b.text)
      .join("");

    return this.parseJSON(raw);
  }

  // ── GEMINI ANALYSIS (FREE) ─────────────────────────────────────────────────

  async runGeminiAnalysis({ charts, asset, session, news, balance, riskPct }) {
    if (!geminiClient) {
      throw new Error("Gemini not configured — set GEMINI_API_KEY in .env");
    }

    const model = geminiClient.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: { responseMimeType: "application/json" },
    });

    // Build parts array — images first, then text
    const parts = [];

    for (const [label, filePath] of [
      ["DAILY chart — HTF trend bias and major S/R levels.",    charts.daily],
      ["15-MINUTE chart — market structure and trade setup.",   charts.m15],
      ["5-MINUTE chart — entry trigger and candle patterns.",   charts.m5],
    ]) {
      if (filePath) {
        const img = this.loadImage(filePath);
        parts.push({ inlineData: { data: img.data, mimeType: img.mimeType } });
        parts.push({ text: label });
      }
    }

    const promptText = buildAnalysisPrompt({
      asset, session, news, balance, riskPct,
      hasCharts: parts.length > 0,
    });

    parts.push({ text: `${buildTraderSystemPrompt()}\n\n${promptText}` });

    const result   = await model.generateContent(parts);
    const raw      = result.response.text();

    return this.parseJSON(raw);
  }

  // ── SHARED HELPERS ─────────────────────────────────────────────────────────

  parseJSON(raw) {
    const clean = raw.replace(/```json|```/g, "").trim();
    try {
      return JSON.parse(clean);
    } catch {
      throw new Error(`Failed to parse signal JSON: ${clean.slice(0, 200)}`);
    }
  }

  loadImage(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = {
      ".jpg":  "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png":  "image/png",
      ".webp": "image/webp",
    };
    const data = fs.readFileSync(filePath);
    return {
      data:     data.toString("base64"),
      mimeType: mimeTypes[ext] || "image/jpeg",
    };
  }

  detectSession() {
    const hour = new Date().getUTCHours();
    if (hour >= 7  && hour < 10) return "London open";
    if (hour >= 12 && hour < 15) return "New York open";
    if (hour >= 12 && hour < 17) return "London-NY overlap";
    if (hour >= 22 || hour < 7)  return "Asian session";
    return "Off-hours";
  }

  isTradeworthy(signal) {
    const conf = signal.confidence || 0;
    const rr   = parseFloat((signal.rr_ratio || "1:0").split(":")[1]) || 0;
    return (
      signal.verdict !== "NEUTRAL" &&
      conf >= this.config.minConfidence &&
      rr   >= this.config.minRR
    );
  }

  // ── OLLAMA ANALYSIS ─────────────────────────────────────────────────────────

  async runOllamaAnalysis({ charts, asset, session, news, balance, riskPct }) {
    const prompt = `${buildTraderSystemPrompt()}\n\n${buildAnalysisPrompt({
      asset, session, news, balance, riskPct,
      hasCharts: charts.daily || charts.m15 || charts.m5,
    })}`;

    // Send request to Ollama API
    const response = await fetch(`${OLLAMA_API_URL}/api/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        prompt: prompt,
        stream: false,
        options: {
          temperature: 0.2,
          top_p: 0.9,
          top_k: 40
        }
      })
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return this.parseJSON(data.response);
  }
}
