import fs from "fs";
import path from "path";

export class Logger {
  constructor(logDir = "./logs") {
    this.logDir = logDir;
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  }

  info(msg) {
    const line = `[${new Date().toISOString()}] INFO  ${msg}`;
    console.log(line);
  }

  warn(msg) {
    const line = `[${new Date().toISOString()}] WARN  ${msg}`;
    console.warn(line);
  }

  error(msg) {
    const line = `[${new Date().toISOString()}] ERROR ${msg}`;
    console.error(line);
  }

  logSignal(signal) {
    const date = new Date().toISOString().split("T")[0];
    const file = path.join(this.logDir, `signals-${date}.jsonl`);
    const line = JSON.stringify({ ...signal, logged_at: new Date().toISOString() });
    fs.appendFileSync(file, line + "\n");
    this.info(`Signal logged → ${file}`);
  }

  getSignalHistory(days = 7) {
    const signals = [];
    for (let i = 0; i < days; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const date = d.toISOString().split("T")[0];
      const file = path.join(this.logDir, `signals-${date}.jsonl`);
      if (fs.existsSync(file)) {
        const lines = fs.readFileSync(file, "utf8").trim().split("\n");
        lines.forEach((l) => {
          try { signals.push(JSON.parse(l)); } catch {}
        });
      }
    }
    return signals;
  }

  getWinRate() {
    const history = this.getSignalHistory(30);
    const closed = history.filter((s) => s.outcome);
    if (!closed.length) return null;
    const wins = closed.filter((s) => s.outcome === "win").length;
    return ((wins / closed.length) * 100).toFixed(1);
  }
}
