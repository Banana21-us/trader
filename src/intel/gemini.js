/**
 * Gemini free-tier intel triage.
 *
 * Deliberately scoped to the cheap half of the cascade. Gemini reads a pile
 * of headlines and returns structure; it does not decide anything. Two
 * outputs, with very different standing:
 *
 *   vetoes — reasons NOT to be positioned right now (scheduled macro event,
 *            exchange halt, depeg, regulatory shock). A veto needs no proven
 *            edge to earn its place: declining to trade cannot lose money.
 *
 *   calls  — directional opinions. These are NOT acted on. They are recorded
 *            to source_calls with a resolve time, scored against realised
 *            price later, and only earn weight after >=30 resolved calls with
 *            a positive Wilson lower bound. Until then their weight is 0.
 *
 * Keeping the analyst layer on Claude and this layer on Gemini is a cost
 * decision: a wrong summary is cheap, a wrong trade is not.
 */

import { GoogleGenerativeAI } from "@google/generative-ai";

const SCHEMA_INSTRUCTIONS = `Return ONLY raw JSON, no markdown fences:
{
  "regime_note": "one sentence on the prevailing narrative",
  "vetoes": [
    { "reason": "why trading should pause", "severity": "high"|"medium",
      "expires_hours": number }
  ],
  "calls": [
    { "symbol": "BTCUSDT", "direction": "LONG"|"SHORT",
      "conviction": 0-100, "horizon_hours": number,
      "basis": "one line citing the headline" }
  ],
  "noise_ratio": 0-100
}
Rules:
- vetoes only for concrete, dated, market-wide events: CPI/FOMC/NFP prints,
  exchange halts or insolvency, stablecoin depegs, major protocol exploits,
  regulatory rulings. Never for general bearish or bullish chatter.
- calls only where a headline gives a specific, falsifiable directional reason.
  Return an empty array rather than inventing one.
- noise_ratio estimates what share of the input is engagement bait.`;

export class GeminiIntel {
  constructor({ apiKey = process.env.GEMINI_API_KEY, model = process.env.GEMINI_MODEL || "gemini-2.0-flash" } = {}) {
    this.enabled = Boolean(apiKey);
    this.modelName = model;
    this.client = this.enabled ? new GoogleGenerativeAI(apiKey) : null;
  }

  async triage(headlines, { symbols = ["BTCUSDT"], maxHeadlines = 60 } = {}) {
    if (!this.enabled) {
      return { available: false, regime_note: "", vetoes: [], calls: [], noise_ratio: null };
    }

    const slice = headlines.slice(0, maxHeadlines);
    if (slice.length === 0) {
      return { available: true, regime_note: "no headlines", vetoes: [], calls: [], noise_ratio: 0 };
    }

    const model = this.client.getGenerativeModel({
      model: this.modelName,
      generationConfig: { responseMimeType: "application/json", temperature: 0.1 },
    });

    const feed = slice
      .map((h, i) => `${i + 1}. [${h.source}] ${h.title}`)
      .join("\n");

    const prompt = `You are triaging crypto news for a systematic trading system.
Tradeable symbols: ${symbols.join(", ")}
Current UTC time: ${new Date().toISOString()}

HEADLINES:
${feed}

${SCHEMA_INSTRUCTIONS}`;

    try {
      const res  = await model.generateContent(prompt);
      const text = res.response.text().replace(/```json|```/g, "").trim();
      const out  = JSON.parse(text);
      return {
        available: true,
        regime_note: out.regime_note || "",
        // The model omits expires_hours often enough that an unguarded value
        // would persist a veto with a NaN expiry — i.e. one that never lifts.
        vetoes: (Array.isArray(out.vetoes) ? out.vetoes : []).map((v) => ({
          reason: v.reason || "unspecified",
          severity: v.severity === "high" ? "high" : "medium",
          expires_hours: Number.isFinite(Number(v.expires_hours)) ? Number(v.expires_hours) : 6,
        })),
        calls:  Array.isArray(out.calls)  ? out.calls  : [],
        noise_ratio: out.noise_ratio ?? null,
        headlinesConsidered: slice.length,
      };
    } catch (err) {
      // Intel is optional. A failure here must never block or open a trade.
      return { available: false, error: err.message, regime_note: "", vetoes: [], calls: [], noise_ratio: null };
    }
  }

  /**
   * Persist directional calls for later scoring. This is the ONLY thing that
   * should ever be done with a call: record it, resolve it, score the source.
   */
  recordCalls(store, triage, { priceLookup = () => null } = {}) {
    if (!triage?.calls?.length) return 0;
    let n = 0;
    for (const c of triage.calls) {
      if (!c.symbol || !c.direction) continue;
      const src = store.upsertSource("llm", `gemini:${this.modelName}`, "Gemini headline triage");
      const horizonH = Number(c.horizon_hours) || 24;
      store.insertSourceCall({
        sourceId: src.id,
        ts: Date.now(),
        symbol: c.symbol,
        direction: c.direction,
        horizonH,
        rawText: c.basis || "",
        priceAtCall: priceLookup(c.symbol),
        resolveAt: Date.now() + horizonH * 3_600_000,
      });
      n++;
    }
    return n;
  }
}

/** Active vetoes, newest first. Expired ones drop out on their own. */
export function activeVetoes(triage, { minSeverity = "medium" } = {}) {
  if (!triage?.vetoes?.length) return [];
  const rank = { medium: 1, high: 2 };
  const floor = rank[minSeverity] ?? 1;
  return triage.vetoes.filter((v) => (rank[v.severity] ?? 0) >= floor);
}
