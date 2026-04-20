/**
 * Web Dashboard — live GUI for the trader bot
 *
 * Runs an HTTP server on DASHBOARD_PORT (default 4200).
 * Open http://localhost:4200 in a browser.
 */

import http from "http";

const PORT = parseInt(process.env.DASHBOARD_PORT || "4200", 10);

// ── SSE broadcast ─────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(line) {
  const msg = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

function patchConsole() {
  for (const level of ["log", "warn", "error", "info"]) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      broadcast({ level, text: args.map(String).join(" "), ts: new Date().toISOString() });
    };
  }
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function buildHtml(assets) {
  const assetOptions = assets.map((a) => `<option value="${a}">${a}</option>`).join("");
  const assetButtons = assets.map((a) => `
    <button class="scan-btn" onclick="scan('${a}')" id="btn-${a}">▶ Scan ${a}</button>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Trader Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Courier New',monospace;background:#0d1117;color:#c9d1d9;min-height:100vh}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#161b22;border-bottom:1px solid #30363d}
  header h1{font-size:18px;color:#58a6ff;letter-spacing:1px}
  #clock{font-size:13px;color:#8b949e}
  .main{display:grid;grid-template-columns:340px 1fr;gap:0;height:calc(100vh - 53px)}
  .sidebar{background:#161b22;border-right:1px solid #30363d;padding:16px;overflow-y:auto;display:flex;flex-direction:column;gap:18px}
  .section-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#8b949e;margin-bottom:8px;border-bottom:1px solid #21262d;padding-bottom:5px}
  .card{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:12px}
  .stat{display:flex;justify-content:space-between;padding:3px 0;font-size:13px}
  .stat .label{color:#8b949e}
  .stat .value{color:#e6edf3;font-weight:bold}
  .green{color:#3fb950}.red{color:#f85149}.yellow{color:#d29922}.blue{color:#58a6ff}

  .scan-btn{width:100%;margin-bottom:6px;padding:9px;background:#1f6feb;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-size:13px;font-weight:bold;transition:background .15s}
  .scan-btn:hover{background:#388bfd}
  .scan-btn:disabled{background:#21262d;color:#8b949e;cursor:not-allowed}
  .scan-btn.running{background:#388bfd;animation:pulse 1s infinite alternate}
  @keyframes pulse{from{opacity:1}to{opacity:.6}}

  /* Manual trade form */
  .trade-form{display:flex;flex-direction:column;gap:8px}
  .form-row{display:grid;grid-template-columns:1fr 1fr;gap:6px}
  .form-group{display:flex;flex-direction:column;gap:3px}
  .form-group label{font-size:11px;color:#8b949e;text-transform:uppercase;letter-spacing:.5px}
  .form-group input,.form-group select{
    background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;
    padding:7px 9px;font-family:inherit;font-size:13px;width:100%
  }
  .form-group input:focus,.form-group select:focus{outline:none;border-color:#58a6ff}
  .side-toggle{display:flex;gap:6px}
  .side-btn{flex:1;padding:8px;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#8b949e;cursor:pointer;font-family:inherit;font-size:13px;font-weight:bold;transition:all .15s}
  .side-btn.buy.active{background:#1a472a;border-color:#3fb950;color:#3fb950}
  .side-btn.sell.active{background:#3d1a1a;border-color:#f85149;color:#f85149}
  .price-display{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px 12px;text-align:center}
  .price-label{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#8b949e;margin-bottom:4px}
  .price-value{font-size:22px;font-weight:bold;color:#e6edf3;letter-spacing:1px}
  .price-value.buy-price{color:#3fb950}
  .price-value.sell-price{color:#f85149}
  .price-sub{font-size:11px;color:#8b949e;margin-top:2px}
  .place-btn{width:100%;padding:11px;background:#238636;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit;font-size:14px;font-weight:bold;margin-top:4px;transition:background .15s}
  .place-btn:hover{background:#2ea043}
  .place-btn:disabled{background:#21262d;color:#8b949e;cursor:not-allowed}
  #trade-msg{font-size:12px;margin-top:4px;min-height:16px}

  table{width:100%;border-collapse:collapse;font-size:12px}
  th{color:#8b949e;font-weight:normal;text-align:left;padding:4px 6px;border-bottom:1px solid #21262d}
  td{padding:4px 6px;border-bottom:1px solid #161b22}
  tr:hover td{background:#161b22}

  .log-panel{display:flex;flex-direction:column;height:100%}
  .log-toolbar{display:flex;align-items:center;gap:10px;padding:10px 16px;background:#161b22;border-bottom:1px solid #30363d}
  .log-toolbar button{padding:4px 10px;background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-family:inherit;font-size:12px}
  .log-toolbar button:hover{background:#30363d}
  #filter{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:3px 8px;font-family:inherit;font-size:12px;width:180px}
  #log{flex:1;overflow-y:auto;padding:12px 16px;font-size:12px;line-height:1.6}
  .log-line{white-space:pre-wrap;word-break:break-all;padding:1px 0}
  .log-line.warn{color:#d29922}.log-line.error{color:#f85149}.log-line.info{color:#58a6ff}
  #status-dot{width:8px;height:8px;border-radius:50%;background:#3fb950;display:inline-block;margin-right:6px;animation:blink 2s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
  #toast{position:fixed;bottom:20px;right:20px;background:#238636;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;display:none;z-index:999}
  #toast.err{background:#b91c1c}
</style>
</head>
<body>
<header>
  <h1><span id="status-dot"></span>AI Trader Bot</h1>
  <div id="clock">Loading...</div>
</header>
<div class="main">

  <div class="sidebar">

    <!-- Account -->
    <div>
      <div class="section-title">Account</div>
      <div class="card">
        <div class="stat"><span class="label">Balance</span><span class="value blue" id="s-balance">—</span></div>
        <div class="stat"><span class="label">Equity</span><span class="value" id="s-equity">—</span></div>
        <div class="stat"><span class="label">Floating P&L</span><span class="value" id="s-floating">—</span></div>
        <div class="stat"><span class="label">Broker</span><span class="value" id="s-broker">—</span></div>
      </div>
    </div>

    <!-- Manual Trade -->
    <div>
      <div class="section-title">Place Manual Trade</div>
      <div class="card trade-form" id="trade-form">

        <div class="form-row">
          <div class="form-group">
            <label>Asset</label>
            <select id="t-asset">${assetOptions}<option value="">Custom…</option></select>
          </div>
          <div class="form-group" id="custom-asset-wrap" style="display:none">
            <label>Custom symbol</label>
            <input id="t-custom" type="text" placeholder="e.g. GBPUSD">
          </div>
        </div>

        <div class="form-group">
          <label>Direction</label>
          <div class="side-toggle">
            <button class="side-btn buy active" id="side-buy"  onclick="setSide('BUY')">▲ BUY</button>
            <button class="side-btn sell"       id="side-sell" onclick="setSide('SELL')">▼ SELL</button>
          </div>
        </div>

        <div class="price-display">
          <div class="price-label">Current Market Price</div>
          <div class="price-value" id="t-price-display">—</div>
          <div class="price-sub" id="t-price-sub"></div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label>Stop Loss</label>
            <input id="t-sl" type="number" step="any" placeholder="0.00000">
          </div>
          <div class="form-group">
            <label>Take Profit</label>
            <input id="t-tp" type="number" step="any" placeholder="0.00000">
          </div>
        </div>

        <div class="form-group">
          <label>Risk ($)</label>
          <input id="t-risk" type="number" step="0.01" placeholder="e.g. 10">
        </div>

        <button class="place-btn" id="place-btn" onclick="placeTrade()">Place Trade</button>
        <div id="trade-msg"></div>
      </div>
    </div>

    <!-- AI Scan -->
    <div>
      <div class="section-title">AI Scan (auto-execute)</div>
      ${assetButtons}
      <div id="scan-result" style="font-size:12px;color:#8b949e;margin-top:4px"></div>
    </div>

    <!-- Open Positions -->
    <div>
      <div class="section-title">Open Positions</div>
      <div id="positions-wrap">
        <div style="color:#8b949e;font-size:12px">No open positions</div>
      </div>
    </div>

  </div>

  <!-- LOG PANEL -->
  <div class="log-panel">
    <div class="log-toolbar">
      <span style="font-size:12px;color:#8b949e">Live Logs</span>
      <input id="filter" type="text" placeholder="Filter logs..." oninput="filterLogs()">
      <button onclick="clearLog()">Clear</button>
      <button onclick="toggleScroll()" id="scroll-btn">Auto-scroll ON</button>
    </div>
    <div id="log"></div>
  </div>

</div>
<div id="toast"></div>

<script>
  let autoScroll = true;
  let allLines   = [];
  let tradeSide  = 'BUY';

  // Clock
  function updateClock() {
    document.getElementById('clock').textContent =
      new Date().toLocaleTimeString('en-PH', { timeZone: 'Asia/Manila', hour12: true }) + ' PH';
  }
  setInterval(updateClock, 1000); updateClock();

  // SSE
  const logEl   = document.getElementById('log');
  const filterEl = document.getElementById('filter');
  const es = new EventSource('/events');
  es.onmessage = (e) => {
    const d = JSON.parse(e.data);
    allLines.push(d);
    if (!filterEl.value || d.text.includes(filterEl.value)) appendLine(d);
  };

  function appendLine({ level, text, ts }) {
    const div = document.createElement('div');
    div.className = 'log-line ' + (level === 'warn' ? 'warn' : level === 'error' ? 'error' : level === 'info' ? 'info' : '');
    div.textContent = '[' + ts.slice(11,19) + '] ' + text;
    logEl.appendChild(div);
    if (logEl.children.length > 2000) logEl.removeChild(logEl.firstChild);
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
  }

  function filterLogs() {
    const q = filterEl.value;
    logEl.innerHTML = '';
    (q ? allLines.filter(l => l.text.includes(q)) : allLines).forEach(appendLine);
  }
  function clearLog()    { logEl.innerHTML = ''; allLines = []; }
  function toggleScroll(){ autoScroll = !autoScroll; document.getElementById('scroll-btn').textContent = 'Auto-scroll ' + (autoScroll ? 'ON' : 'OFF'); }

  // Custom asset toggle
  document.getElementById('t-asset').addEventListener('change', function() {
    document.getElementById('custom-asset-wrap').style.display = this.value === '' ? 'block' : 'none';
  });

  // Live price fetch
  let _priceTimer = null;
  let _currentPrice = null;

  async function fetchPrice() {
    const assetSel = document.getElementById('t-asset').value;
    const asset    = assetSel || document.getElementById('t-custom').value.trim().toUpperCase();
    if (!asset) return;

    try {
      const res  = await fetch('/api/price/' + asset);
      const data = await res.json();
      if (data.error) { showLivePrice(null, asset); return; }
      _currentPrice = tradeSide === 'BUY' ? data.ask : data.bid;
      showLivePrice(_currentPrice, asset, data.ask, data.bid);
    } catch {
      showLivePrice(null, asset);
    }
  }

  function showLivePrice(price, asset, ask, bid) {
    const el  = document.getElementById('t-price-display');
    const sub = document.getElementById('t-price-sub');
    if (!price) {
      el.textContent = '—';
      el.className   = 'price-value';
      sub.textContent = 'Bridge not connected';
      return;
    }
    el.textContent = price.toFixed(5);
    el.className   = 'price-value ' + (tradeSide === 'BUY' ? 'buy-price' : 'sell-price');
    sub.textContent = (tradeSide === 'BUY' ? 'ASK' : 'BID') + (ask && bid ? '  |  ask ' + ask.toFixed(5) + '  bid ' + bid.toFixed(5) : '');
  }

  function startPricePolling() {
    clearInterval(_priceTimer);
    fetchPrice();
    _priceTimer = setInterval(fetchPrice, 2000);
  }

  document.getElementById('t-asset').addEventListener('change', startPricePolling);
  document.getElementById('t-custom').addEventListener('input', () => { clearTimeout(_priceTimer); setTimeout(startPricePolling, 600); });
  startPricePolling();

  // Side toggle
  function setSide(side) {
    tradeSide = side;
    document.getElementById('side-buy').classList.toggle('active', side === 'BUY');
    document.getElementById('side-sell').classList.toggle('active', side === 'SELL');
    fetchPrice();
  }

  // Place manual trade
  async function placeTrade() {
    const assetSel = document.getElementById('t-asset').value;
    const asset    = assetSel || document.getElementById('t-custom').value.trim().toUpperCase();
    const sl       = parseFloat(document.getElementById('t-sl').value);
    const tp       = parseFloat(document.getElementById('t-tp').value);
    const risk     = parseFloat(document.getElementById('t-risk').value);
    const btn      = document.getElementById('place-btn');

    if (!asset)          { setMsg('Asset is required', true); return; }
    if (!sl    || sl<=0) { setMsg('Enter a valid stop loss', true); return; }
    if (!tp    || tp<=0) { setMsg('Enter a valid take profit', true); return; }

    if (_currentPrice) {
      if (tradeSide === 'BUY') {
        if (sl >= _currentPrice) { setMsg('BUY: Stop Loss must be BELOW current price (' + _currentPrice.toFixed(5) + ')', true); return; }
        if (tp <= _currentPrice) { setMsg('BUY: Take Profit must be ABOVE current price (' + _currentPrice.toFixed(5) + ')', true); return; }
      } else {
        if (sl <= _currentPrice) { setMsg('SELL: Stop Loss must be ABOVE current price (' + _currentPrice.toFixed(5) + ')', true); return; }
        if (tp >= _currentPrice) { setMsg('SELL: Take Profit must be BELOW current price (' + _currentPrice.toFixed(5) + ')', true); return; }
      }
    }

    btn.disabled = true;
    btn.textContent = 'Placing…';
    setMsg('');

    try {
      const res = await fetch('/api/trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset, side: tradeSide, sl, tp, risk: risk || 0 }),
      });
      const data = await res.json();
      if (data.success) {
        setMsg('✅ Order placed — ID: ' + data.orderId, false);
        showToast('Trade placed: ' + tradeSide + ' ' + asset);
      } else {
        setMsg('❌ ' + (data.error || 'Failed'), true);
        showToast(data.error || 'Trade failed', true);
      }
    } catch (err) {
      setMsg('❌ ' + err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Place Trade';
    }
  }

  function setMsg(text, isErr) {
    const el = document.getElementById('trade-msg');
    el.textContent = text;
    el.style.color = isErr ? '#f85149' : '#3fb950';
  }

  // AI scan
  async function scan(asset) {
    const btn = document.getElementById('btn-' + asset);
    btn.disabled = true; btn.classList.add('running');
    btn.textContent = '⏳ Scanning ' + asset + '...';
    document.getElementById('scan-result').textContent = '';
    try {
      const res  = await fetch('/api/scan', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ asset }) });
      const data = await res.json();
      const msg  = data.grade ? 'Grade: ' + data.grade + ' | ' + data.verdict + ' | Conf: ' + data.confidence + '%' : (data.message || 'Done');
      document.getElementById('scan-result').textContent = asset + ': ' + msg;
      showToast(asset + ' scan done — ' + (data.grade || 'done'));
    } catch (err) {
      document.getElementById('scan-result').textContent = 'Error: ' + err.message;
    } finally {
      btn.disabled = false; btn.classList.remove('running');
      btn.textContent = '▶ Scan ' + asset;
    }
  }

  // Status polling
  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const d   = await res.json();
      document.getElementById('s-broker').textContent = d.broker || '—';
      if (d.account) {
        document.getElementById('s-balance').textContent = '$' + (d.account.balance || 0).toFixed(2);
        document.getElementById('s-equity').textContent  = '$' + (d.account.equity  || 0).toFixed(2);
        const fl = (d.account.equity || 0) - (d.account.balance || 0);
        const flEl = document.getElementById('s-floating');
        flEl.textContent = (fl >= 0 ? '+' : '') + '$' + fl.toFixed(2);
        flEl.className   = 'value ' + (fl >= 0 ? 'green' : 'red');
      }
      if (d.positions && d.positions.length) {
        let html = '<table><tr><th>Symbol</th><th>Side</th><th>P&L</th><th>Entry</th></tr>';
        for (const p of d.positions) {
          const cls = p.profit >= 0 ? 'green' : 'red';
          html += '<tr>'
            + '<td>' + p.symbol + '</td>'
            + '<td class="' + (p.side==='BUY'?'green':'red') + '">' + p.side + '</td>'
            + '<td class="' + cls + '">' + (p.profit>=0?'+':'') + '$' + parseFloat(p.profit).toFixed(2) + '</td>'
            + '<td>' + parseFloat(p.entry).toFixed(5) + '</td>'
            + '</tr>';
        }
        document.getElementById('positions-wrap').innerHTML = html + '</table>';
      } else {
        document.getElementById('positions-wrap').innerHTML = '<div style="color:#8b949e;font-size:12px">No open positions</div>';
      }
    } catch {}
  }
  setInterval(refreshStatus, 5000); refreshStatus();

  function showToast(msg, isErr) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className   = isErr ? 'err' : '';
    t.style.display = 'block';
    setTimeout(() => t.style.display = 'none', 3500);
  }
</script>
</body>
</html>`;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

export function startDashboard({ assets, broker, brokerExecutor, scanAsset, getLiveBalance, bridgeUrl, bridgeSecret }) {

  patchConsole();

  function readBody(req) {
    return new Promise((resolve) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        try { resolve(JSON.parse(b)); } catch { resolve({}); }
      });
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // SSE
    if (url.pathname === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" });
      res.write(": connected\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    // Status
    if (url.pathname === "/api/status" && req.method === "GET") {
      let account = null, positions = [];
      const headers = { "Content-Type": "application/json", ...(bridgeSecret ? { "X-Secret": bridgeSecret } : {}) };
      try { account   = await (await fetch(`${bridgeUrl}/account`,   { headers })).json(); } catch {}
      try { const p   = await (await fetch(`${bridgeUrl}/positions`,  { headers })).json(); positions = Array.isArray(p) ? p : []; } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ broker, assets, account, positions }));
      return;
    }

    // Live price proxy
    if (url.pathname.startsWith("/api/price/") && req.method === "GET") {
      const symbol = url.pathname.split("/api/price/")[1].toUpperCase();
      const headers = { "Content-Type": "application/json", ...(bridgeSecret ? { "X-Secret": bridgeSecret } : {}) };
      try {
        const r    = await fetch(`${bridgeUrl}/price/${symbol}`, { headers });
        const data = await r.json();
        res.writeHead(r.ok ? 200 : 404, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
      } catch {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bridge not reachable" }));
      }
      return;
    }

    // Manual trade
    if (url.pathname === "/api/trade" && req.method === "POST") {
      const body = await readBody(req);
      const { asset, side, sl, tp, risk } = body;

      if (!asset || !side || !sl || !tp) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "asset, side, sl, tp are required" }));
        return;
      }

      console.log(`[Dashboard] Manual trade: ${side} ${asset} SL=${sl} TP=${tp} risk=$${risk || "auto"}`);

      // Build a synthetic signal that bypasses AI — broker.execute() only needs these fields
      // Fetch live price so the log shows a real number
      let livePrice = "market";
      try {
        const headers = { "Content-Type": "application/json", ...(bridgeSecret ? { "X-Secret": bridgeSecret } : {}) };
        const pr = await (await fetch(`${bridgeUrl}/price/${asset}`, { headers })).json();
        livePrice = side === "BUY" ? pr.ask : pr.bid;
      } catch {}

      const signal = {
        verdict:     side,
        entry:       String(livePrice),
        stop_loss:   String(sl),
        take_profit: String(tp),
        confidence:  100,
        meta: {
          asset,
          grade:         "A",
          isTradeworthy: true,
          riskAmount:    risk || null,
          positionSize:  null,
        },
      };

      try {
        const result = await brokerExecutor.execute(signal);
        if (result.success) {
          console.log(`[Dashboard] ✅ Trade placed — ${side} ${asset} @ ${livePrice} | SL: ${sl} TP: ${tp} | Order: ${result.orderId}`);
        } else if (result.skipped) {
          console.log(`[Dashboard] ⚠️ Trade skipped: ${result.reason}`);
        } else {
          console.log(`[Dashboard] ❌ Trade failed: ${result.error}`);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[Dashboard] Trade error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // AI scan
    if (url.pathname === "/api/scan" && req.method === "POST") {
      const body = await readBody(req);
      const { asset } = body;

      if (!asset || !assets.includes(asset)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid asset" }));
        return;
      }

      console.log(`[Dashboard] AI scan: ${asset}`);
      try {
        const balance = await getLiveBalance();
        const signal  = await scanAsset(asset, balance, "Manual");
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          grade:      signal?.meta?.grade   || "skip",
          verdict:    signal?.verdict       || "NEUTRAL",
          confidence: signal?.confidence    || 0,
          asset,
        }));
      } catch (err) {
        console.error("[Dashboard] Scan error:", err.message);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // HTML
    if (url.pathname === "/" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(buildHtml(assets));
      return;
    }

    res.writeHead(404);
    res.end("Not found");
  });

  server.listen(PORT, () => {
    console.log(`[Dashboard] http://localhost:${PORT}`);
  });

  return server;
}
