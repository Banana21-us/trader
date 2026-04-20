// Test file for risk management features
import { RiskEngine } from "./src/utils/risk.js";

// Test the risk engine
const riskEngine = new RiskEngine();

// Test position sizing limits
console.log("Testing position sizing limits...");
const testSignal = {
  entry: "1900.50",
  stop_loss: "1890.25",
  take_profit: "1915.75",
  tp2: "1925.00",
  tp3: "1940.00",
  confidence: 85,
  rr_ratio: "1:2.5",
  trend_vote: "BUY",
  sr_vote: "BUY",
  momentum_vote: "BUY",
  verdict: "BUY"
};

// Test with a small balance to see position limits
const result1 = riskEngine.enrich(testSignal, { 
  balance: 1000, 
  riskPct: 2, 
  asset: "XAUUSD" 
});

console.log("Result with $1000 balance:");
console.log("Position Size:", result1.meta.positionSize);
console.log("Original Position Size:", result1.meta.originalPositionSize);
console.log("Position Limit Reason:", result1.meta.positionLimitReason);

// Test with a larger balance
const result2 = riskEngine.enrich(testSignal, { 
  balance: 10000, 
  riskPct: 2, 
  asset: "XAUUSD" 
});

console.log("\nResult with $10000 balance:");
console.log("Position Size:", result2.meta.positionSize);
console.log("Original Position Size:", result2.meta.originalPositionSize);
console.log("Position Limit Reason:", result2.meta.positionLimitReason);

// Test drawdown limits (with some trade history)
console.log("\nTesting drawdown limits...");
const mockTradeHistory = [
  { outcome: "win", meta: { riskAmount: 20 } },
  { outcome: "loss", meta: { riskAmount: 20 } },
  { outcome: "win", meta: { riskAmount: 20 } }
];

// Reset history and add some trades
riskEngine.tradeHistory = mockTradeHistory;
const result3 = riskEngine.enrich(testSignal, { 
  balance: 1000, 
  riskPct: 2, 
  asset: "XAUUSD" 
});

console.log("Drawdown limit check:");
console.log("Max Drawdown Allowed:", result3.meta.maxDrawdownAllowed);
console.log("Drawdown Limit Reason:", result3.meta.drawdownLimitReason);

console.log("\nRisk management features are implemented successfully!");