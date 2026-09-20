import { RiskEngine } from "./src/utils/risk.js";

const re = new RiskEngine({ roundTripBps: 30 });
const P = (s) => JSON.stringify(s);

console.log("=== A. The 46x leverage case (old code let this through) ===");
// $500 account, 1% risk, gold 2300, tight $0.50 stop -> 10 units = $23,000 notional
const big = {
  verdict: "BUY", confidence: 90, entry: "2300.00", stop_loss: "2299.50",
  take_profit: "2302.00", tp2: "2305.00", rr_ratio: "1:10",
};
const e1 = re.enrich(big, { balance: 500, riskPct: 1, asset: "XAUUSD" });
const notional = (parseFloat(e1.meta.positionSize) || 0) * 2300;
console.log("original size :", e1.meta.originalPositionSize, "units =", (e1.meta.originalPositionSize*2300).toFixed(0), "USD notional");
console.log("capped size   :", e1.meta.positionSize, "units =", notional.toFixed(0), "USD notional");
console.log("cap reason    :", e1.meta.positionLimitReason);
console.log("limit was     : $" + (500*0.10).toFixed(0), "(10% of equity)");
console.log("PASS:", notional <= 500*0.10 + 1);

console.log("\n=== B. Self-reported R:R can no longer buy a grade ===");
// Model claims 1:10 but the levels only give ~1:1
const liar = {
  verdict: "BUY", confidence: 95, entry: "100", stop_loss: "99", take_profit: "101", tp2: "101",
  rr_ratio: "1:10",
  trend_vote:"BUY", sr_vote:"BUY", momentum_vote:"BUY",
  order_block:"99-100", fvg:"99.5", fibonacci_level:"0.618", liquidity_level:"98",
};
console.log("model claims rr_ratio:", liar.rr_ratio);
console.log("computed R:R        :", re.computedRR(liar));
console.log("grade               :", re.gradeSignal(liar), "(old code: A+ on the claim)");
console.log("PASS:", re.gradeSignal(liar) !== "A+");

console.log("\n=== C. Stop tighter than costs is rejected ===");
const tight = { verdict:"BUY", confidence:90, entry:"2300", stop_loss:"2298.85", take_profit:"2310", tp2:"2320" };
console.log("stop distance : 1.15 (5bps of price)");
console.log("cost in R     :", re.costInR(tight).toFixed(2), "R");
console.log("tradeworthy   :", re.isTradeworthy(tight), "(old code: true)");
console.log("PASS:", re.isTradeworthy(tight) === false);

console.log("\n=== D. A genuinely good setup still passes ===");
const good = {
  verdict:"BUY", confidence:82, entry:"2300", stop_loss:"2277", take_profit:"2346", tp2:"2392",
  trend_vote:"BUY", sr_vote:"BUY", momentum_vote:"BUY",
};
console.log("stop distance : 23 (1% of price)");
console.log("computed R:R  :", re.computedRR(good), " cost:", re.costInR(good).toFixed(3), "R");
console.log("grade         :", re.gradeSignal(good));
console.log("tradeworthy   :", re.isTradeworthy(good));
console.log("PASS:", re.isTradeworthy(good) === true);

console.log("\n=== E. enrich() no longer mutates exposure state ===");
const before = re.currentPositions.size;
re.enrich(good, { balance: 500, riskPct: 1, asset: "BTCUSDT" });
re.enrich(good, { balance: 500, riskPct: 1, asset: "BTCUSDT" });
re.enrich(good, { balance: 500, riskPct: 1, asset: "BTCUSDT" });
console.log("positions tracked after 3 analyses:", re.currentPositions.size, "(old code: grew each call)");
console.log("PASS:", re.currentPositions.size === before);
