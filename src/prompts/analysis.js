export function buildAnalysisPrompt({ asset, session, news, balance, riskPct, hasCharts }) {
  const base = `
TRADE ANALYSIS REQUEST
======================
Asset:    ${asset}
Session:  ${session}
Balance:  $${balance.toLocaleString()}
Risk:     ${riskPct}% ($${(balance * riskPct / 100).toFixed(2)} per trade)
News:     ${news}
`;

  if (hasCharts) {
    return base + `
Charts provided: Daily (HTF) + 15min (structure) + 5min (entry) — see images above.

Apply full top-down institutional analysis:

STEP 1 — DAILY CHART:
  - What is the HTF trend? Last BOS or CHoCH?
  - Where are the major OBs, FVGs, and liquidity pools?
  - Is price in premium or discount relative to the range?
  - What is the weekly bias?

STEP 2 — 15MIN CHART:
  - What is the current market structure?
  - Has there been a liquidity sweep recently?
  - Where is the nearest valid OB or FVG for entry?
  - Is there a CHoCH confirming reversal or continuation?

STEP 3 — 5MIN CHART:
  - What is the entry trigger? (displacement candle, engulfing, pin bar)
  - Is there a micro FVG or OB at entry?
  - What confirms the move?

STEP 4 — TAKE PROFIT MAPPING (READ THE CHART):
  - Scan upward (BUY) or downward (SELL) from entry
  - Identify EVERY level price will encounter: FVGs, OBs, swing highs, round numbers, daily/weekly levels
  - TP1 = nearest level, TP2 = primary level, TP3 = furthest significant level with clear path
  - If the chart shows a 10R or 12R runner with nothing blocking it — that IS the target
  - Calculate Fibonacci extensions from the visible swing and map them to chart levels

Cross-check with news context. Give your complete signal in JSON.`;
  }

  return base + `
No chart screenshots provided.

Generate a realistic signal for ${asset} during ${session} based on your knowledge of current price levels, typical SMC structures for this asset, and the news context provided.

Use real current price levels. Apply ICT methodology — identify likely OBs, FVGs, and liquidity pools from memory. Mark trade_quality as "B" or lower since no visual chart confirmation is available.

Give your full signal in JSON.`;
}

export function buildRefinementPrompt({ signal, question }) {
  return `Here is a previously generated trade signal:

${JSON.stringify(signal, null, 2)}

Trader question: ${question}

Answer as an experienced trader. Be specific and concise. No JSON needed — plain text response.`;
}

export function buildNewsPrompt({ asset, headlines }) {
  return `You are analyzing news sentiment for trading ${asset}.

Headlines:
${headlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}

Respond with JSON:
{
  "sentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "strength": 0-100,
  "key_drivers": "one sentence summary of main drivers",
  "risk_events": "upcoming events to watch or 'none'"
}`;
}
