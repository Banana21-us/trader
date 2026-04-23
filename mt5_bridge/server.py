#!/usr/bin/env python3
"""
MT5 Bridge Server for AI Trader Bot
====================================
Runs as a persistent HTTP REST server on localhost.
Keeps MT5 connection alive so every trade doesn't reconnect.
The Node.js trader-bot calls this to execute real orders.

Start: python mt5_bridge/server.py
       (MT5 terminal must be open and logged in)
"""

from flask import Flask, request, jsonify
import MetaTrader5 as mt5
import os, threading, time, sys
from datetime import datetime

app = Flask(__name__)

# ── CONFIG ────────────────────────────────────────────────────────────────────
MT5_LOGIN    = int(os.environ.get("MT5_LOGIN", 0))
MT5_PASSWORD = os.environ.get("MT5_PASSWORD", "")
MT5_SERVER   = os.environ.get("MT5_SERVER", "")
PORT         = int(os.environ.get("MT5_BRIDGE_PORT", 15555))
SECRET       = os.environ.get("MT5_BRIDGE_SECRET", "")

# ── PERSISTENT MT5 CONNECTION ─────────────────────────────────────────────────
_lock      = threading.Lock()
_connected = False

def ensure_connected():
    global _connected
    with _lock:
        # Quick check — if already connected and terminal responds, we're good
        if _connected:
            try:
                if mt5.terminal_info() is not None:
                    return True
            except:
                pass

        print("[MT5] Connecting...")
        _connected = mt5.initialize()
        if not _connected:
            print(f"[MT5] Initialize failed: {mt5.last_error()}")
            return False

        if MT5_LOGIN:
            ok = mt5.login(MT5_LOGIN, MT5_PASSWORD, MT5_SERVER)
            if not ok:
                print(f"[MT5] Login failed: {mt5.last_error()}")
                _connected = False
                return False

        info = mt5.terminal_info()
        acc  = mt5.account_info()
        print(f"[MT5] Connected — account {acc.login if acc else '?'} | "
              f"balance ${acc.balance:.2f} | "
              f"AutoTrading: {'✓' if info and info.trade_allowed else '✗ DISABLED'}")
        _connected = True
        return True

# Keep-alive ping every 30s
def _keepalive():
    while True:
        time.sleep(30)
        ensure_connected()

threading.Thread(target=_keepalive, daemon=True).start()

# ── AUTH ──────────────────────────────────────────────────────────────────────
def check_auth():
    if SECRET and request.headers.get("X-Secret") != SECRET:
        return jsonify({"error": "unauthorized"}), 401
    return None

# ── LOT SIZE CALCULATOR ───────────────────────────────────────────────────────
def calc_lot(symbol, entry_price, sl_price, risk_usd):
    """
    Calculates lot size so that hitting SL = exactly risk_usd loss.
    Uses MT5's own tick value data so it works for any broker/account currency.
    """
    sym = mt5.symbol_info(symbol)
    if not sym:
        return 0.01

    pip_risk = abs(entry_price - sl_price)
    if pip_risk < sym.point:
        return sym.volume_min

    # Value of 1 tick move per 1 lot (in account currency)
    tick_value = sym.trade_tick_value
    tick_size  = sym.trade_tick_size

    if tick_size == 0 or tick_value == 0:
        return sym.volume_min

    # Risk per lot if SL is hit
    risk_per_lot = (pip_risk / tick_size) * tick_value

    if risk_per_lot == 0:
        return sym.volume_min

    lot = risk_usd / risk_per_lot

    # Clamp to broker limits and round to volume step
    lot = round(lot / sym.volume_step) * sym.volume_step
    lot = max(sym.volume_min, min(sym.volume_max, lot))
    return round(lot, 2)

# ── ENDPOINTS ─────────────────────────────────────────────────────────────────

@app.route("/health")
def health():
    ok = ensure_connected()
    if not ok:
        return jsonify({"status": "error", "connected": False,
                        "hint": "MT5 terminal must be open"}), 503

    term = mt5.terminal_info()
    acc  = mt5.account_info()
    return jsonify({
        "status":        "ok",
        "connected":     True,
        "trade_allowed": term.trade_allowed if term else False,
        "account":       acc.login   if acc else None,
        "balance":       acc.balance if acc else None,
        "equity":        acc.equity  if acc else None,
    })


@app.route("/account")
def account():
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    acc = mt5.account_info()
    if not acc:
        return jsonify({"error": "Failed to get account info"}), 500

    return jsonify({
        "login":       acc.login,
        "balance":     acc.balance,
        "equity":      acc.equity,
        "profit":      acc.profit,
        "margin":      acc.margin,
        "free_margin": acc.margin_free,
        "leverage":    acc.leverage,
        "currency":    acc.currency,
    })


@app.route("/positions")
def positions():
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    pos = mt5.positions_get()
    if pos is None:
        return jsonify([])

    return jsonify([{
        "ticket":    p.ticket,
        "symbol":    p.symbol,
        "side":      "BUY" if p.type == 0 else "SELL",
        "volume":    p.volume,
        "entry":     p.price_open,
        "current":   p.price_current,
        "sl":        p.sl,
        "tp":        p.tp,
        "profit":    p.profit,
        "swap":      p.swap,
        "comment":   p.comment,
        "open_time": datetime.fromtimestamp(p.time).isoformat(),
    } for p in pos])


@app.route("/history")
def history():
    """Recent closed deals — used for consecutive-loss kill switch + stats."""
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    hours = int(request.args.get("hours", 168))  # default 7 days
    from_ts = int(time.time()) - hours * 3600
    deals = mt5.history_deals_get(datetime.fromtimestamp(from_ts), datetime.now())

    if deals is None:
        return jsonify([])

    # Only closing deals that realized P&L (entry=OUT = closed position)
    closed = [d for d in deals if d.entry == 1]  # DEAL_ENTRY_OUT
    return jsonify([{
        "ticket":  d.ticket,
        "symbol":  d.symbol,
        "profit":  d.profit,
        "volume":  d.volume,
        "time":    datetime.fromtimestamp(d.time).isoformat(),
        "comment": d.comment,
    } for d in sorted(closed, key=lambda x: x.time, reverse=True)])


@app.route("/candles/<symbol>")
def candles(symbol):
    """Historical OHLCV candles — used by the backtest harness."""
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    tf_map = {
        "M1":  mt5.TIMEFRAME_M1,  "M5":  mt5.TIMEFRAME_M5,
        "M15": mt5.TIMEFRAME_M15, "M30": mt5.TIMEFRAME_M30,
        "H1":  mt5.TIMEFRAME_H1,  "H4":  mt5.TIMEFRAME_H4,
        "D1":  mt5.TIMEFRAME_D1,
    }
    tf_name = request.args.get("tf", "M15").upper()
    count   = min(int(request.args.get("count", 500)), 5000)
    tf      = tf_map.get(tf_name, mt5.TIMEFRAME_M15)
    symbol  = symbol.replace("/", "").upper()

    rates = mt5.copy_rates_from_pos(symbol, tf, 0, count)
    if rates is None or len(rates) == 0:
        return jsonify({"error": f"No candle data for {symbol} {tf_name}"}), 404

    return jsonify([{
        "t": int(r["time"]),
        "o": float(r["open"]),
        "h": float(r["high"]),
        "l": float(r["low"]),
        "c": float(r["close"]),
        "v": int(r["tick_volume"]),
    } for r in rates])


@app.route("/price/<symbol>")
def price(symbol):
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    symbol = symbol.replace("/", "").upper()
    sym = mt5.symbol_info(symbol)
    if not sym:
        return jsonify({"error": f"Symbol {symbol} not found"}), 404
    if not sym.visible:
        mt5.symbol_select(symbol, True)

    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return jsonify({"error": "No tick data"}), 500

    return jsonify({
        "symbol": symbol,
        "bid":    tick.bid,
        "ask":    tick.ask,
        "time":   tick.time,
    })


@app.route("/execute", methods=["POST"])
def execute():
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    data        = request.json or {}
    symbol      = data.get("symbol", "XAUUSD").replace("/", "")
    side        = data.get("side", "BUY").upper()
    sl_price    = float(data.get("sl", 0))
    tp_price    = float(data.get("tp", 0))
    risk_usd    = float(data.get("risk_amount", 10))
    comment     = str(data.get("comment", "TraderBot"))[:31]

    # Check auto-trading is enabled
    term = mt5.terminal_info()
    if not term or not term.trade_allowed:
        return jsonify({
            "error": "AutoTrading is DISABLED in MT5. "
                     "Click the AutoTrading button in the MT5 toolbar."
        }), 400

    # Ensure symbol visible
    sym = mt5.symbol_info(symbol)
    if not sym:
        return jsonify({"error": f"Symbol {symbol} not found in MT5"}), 400
    if not sym.visible:
        mt5.symbol_select(symbol, True)
        sym = mt5.symbol_info(symbol)

    # Get live price
    tick = mt5.symbol_info_tick(symbol)
    if not tick:
        return jsonify({"error": "Failed to get price tick"}), 500

    price      = tick.ask if side == "BUY" else tick.bid
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL

    # Calculate lot size from risk amount
    lot = calc_lot(symbol, price, sl_price, risk_usd) if sl_price else sym.volume_min

# Try different filling modes - demo accounts often only support RETURN
    filling_modes = [
        mt5.ORDER_FILLING_RETURN,  # Most compatible - allows partial fills
        mt5.ORDER_FILLING_IOC,  # Immediate or Cancel
        mt5.ORDER_FILLING_FOK,  # Fill or Kill
    ]

    result = None
    last_error = None

    for filling_mode in filling_modes:
        req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       symbol,
            "volume":       lot,
            "type":         order_type,
            "price":        price,
            "sl":           sl_price if sl_price else 0.0,
            "tp":           tp_price if tp_price else 0.0,
            "deviation":   20,
            "magic":        234001,
            "comment":     comment,
            "type_time":   mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

        result = mt5.order_send(req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            break
        last_error = f"{result.comment} (retcode {result.retcode})"
        print(f"[MT5] Filling mode {filling_mode} failed, trying next...")

    if result.retcode != mt5.TRADE_RETCODE_DONE:
        msg = last_error
        if result.retcode == 10027: msg += " — Enable AutoTrading in MT5"
        if result.retcode == 10018: msg += " — No connection to trade server"
        if result.retcode == 10014: msg += " — Invalid price, requote"
        if result.retcode == 10016: msg += f" — SL/TP invalid: for BUY, SL must be below {price:.5f} and TP above it; for SELL, reversed"
        if result.retcode == 10030: msg += " — Broker doesn't support order type"
        print(f"[MT5] Order FAILED: {msg}")
        return jsonify({"error": msg, "retcode": result.retcode}), 400

    print(f"[MT5] ✓ {side} {lot} lots {symbol} @ {result.price:.2f} "
          f"| SL: {sl_price:.2f} TP: {tp_price:.2f} | ticket: {result.order}")

    return jsonify({
        "success":  True,
        "order_id": result.order,
        "price":    result.price,
        "volume":   result.volume,
        "lot":      lot,
    })


@app.route("/close/<int:ticket>", methods=["POST"])
def close_position(ticket):
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return jsonify({"error": f"Position {ticket} not found"}), 404

    p          = pos[0]
    tick       = mt5.symbol_info_tick(p.symbol)
    close_price = tick.bid if p.type == 0 else tick.ask
    close_type  = mt5.ORDER_TYPE_SELL if p.type == 0 else mt5.ORDER_TYPE_BUY

    # Try different filling modes for close operations
    filling_modes = [
        mt5.ORDER_FILLING_RETURN,
        mt5.ORDER_FILLING_IOC,
        mt5.ORDER_FILLING_FOK,
    ]

    result = None
    last_error = None

    for filling_mode in filling_modes:
        req = {
            "action":       mt5.TRADE_ACTION_DEAL,
            "symbol":       p.symbol,
            "volume":       p.volume,
            "type":         close_type,
            "position":     ticket,
            "price":        close_price,
            "deviation":    20,
            "magic":        234001,
            "comment":      "TraderBot close",
            "type_time":    mt5.ORDER_TIME_GTC,
            "type_filling": filling_mode,
        }

        result = mt5.order_send(req)
        if result.retcode == mt5.TRADE_RETCODE_DONE:
            break
        last_error = f"{result.comment} (retcode {result.retcode})"
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": result.comment, "retcode": result.retcode}), 400

    print(f"[MT5] ✓ Closed ticket {ticket} @ {close_price:.2f} | P&L: ${p.profit:.2f}")
    return jsonify({"success": True, "order_id": result.order, "close_price": close_price})


@app.route("/modify/<int:ticket>", methods=["POST"])
def modify_position(ticket):
    err = check_auth()
    if err: return err
    if not ensure_connected():
        return jsonify({"error": "MT5 not connected"}), 503

    data   = request.json or {}
    new_sl = float(data.get("sl", 0))
    new_tp = float(data.get("tp", 0))

    pos = mt5.positions_get(ticket=ticket)
    if not pos:
        return jsonify({"error": f"Position {ticket} not found"}), 404

    p = pos[0]
    req = {
        "action":   mt5.TRADE_ACTION_SLTP,
        "symbol":   p.symbol,
        "position": ticket,
        "sl":       new_sl if new_sl else p.sl,
        "tp":       new_tp if new_tp else p.tp,
    }

    result = mt5.order_send(req)
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return jsonify({"error": result.comment, "retcode": result.retcode}), 400

    print(f"[MT5] ✓ Modified ticket {ticket} | new SL: {new_sl:.2f} TP: {new_tp:.2f}")
    return jsonify({"success": True, "sl": new_sl, "tp": new_tp})


# ── STARTUP ───────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    print("""
╔══════════════════════════════════════════╗
║       MT5 BRIDGE SERVER                  ║
╚══════════════════════════════════════════╝
""")
    if not ensure_connected():
        print("[MT5] WARNING: Could not connect on startup.")
        print("      Make sure MetaTrader 5 is open and logged in.")

    print(f"[Bridge] Listening on http://127.0.0.1:{PORT}")
    print(f"[Bridge] Auth:   {'enabled' if SECRET else 'disabled (set MT5_BRIDGE_SECRET)'}\n")

    app.run(host="127.0.0.1", port=PORT, threaded=True, use_reloader=False)
