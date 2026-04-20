/**
 * Telegram alerter with inline YES / NO execution buttons
 *
 * Flow:
 *   1. Signal fires → sendSignal() sends message with [✅ EXECUTE] [❌ SKIP] buttons
 *   2. You tap a button on your phone
 *   3. startCallbackListener() catches the tap via long-polling
 *   4. If EXECUTE → calls onExecute(signal) → broker places the order
 *   5. If SKIP    → sends a confirmation that you skipped
 *
 * Setup:
 *   - Create bot via @BotFather → get TELEGRAM_BOT_TOKEN
 *   - Get your chat id via @userinfobot → TELEGRAM_CHAT_ID
 */

export class TelegramAlerter {
  constructor() {
    this.token   = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId  = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);
    this.baseUrl = `https://api.telegram.org/bot${this.token}`;

    this.pending    = new Map(); // pending signals waiting for button tap
    this.pollOffset = 0;
    this.polling    = false;

    if (!this.enabled) {
      console.warn("[Telegram] Disabled — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID.");
    } else {
      this.sendText("✅ Trader bot connected! You will receive trade signals here.")
        .catch((err) => console.warn("[Telegram] Startup message failed:", err.message));
    }
  }

  // ─── TEST CONNECTION ───────────────────────────────────────────────────────

  async testConnection() {
    if (!this.enabled) return false;
    const res = await this.sendText("🧪 Test message — bot is working!");
    return res?.ok;
  }

  // ─── SEND SIGNAL WITH BUTTONS ────────────────────────────────────────────

  async sendSignal(signal, { onExecute, onSkip } = {}) {
    if (!this.enabled) return;

    const { meta } = signal;
    const arrow = signal.verdict === "BUY" ? "🟢" : signal.verdict === "SELL" ? "🔴" : "🟡";
    const grade = meta?.grade || "?";
    const id    = `sig_${Date.now()}`;

    const pa       = meta?.partialAmounts;
    const isAPlus  = grade === "A+";
    const gradeStr = isAPlus ? "A+ ⭐" : grade;

    const text = [
      `${arrow} *${signal.verdict} SIGNAL* — ${meta?.asset || "?"} [${gradeStr}]`,
      ``,
      `📊 Confidence: *${signal.confidence}%*`,
      `📝 ${signal.summary}`,
      `🌐 Weekly bias: ${signal.weekly_bias || "?"}`,
      ``,
      `*Entry:*     \`${signal.entry}\`  _(${signal.entry_type || "market"})_`,
      `*Stop Loss:* \`${signal.stop_loss}\``,
      ``,
      `*🎯 Take Profits:*`,
      `  TP1 (${pa?.tp1?.pct || 40}%) \`${signal.take_profit}\` → +$${pa?.tp1?.amount ?? "?"}  R:R 1:${meta?.rrTp1 ?? "?"}`,
      `  TP2 (${pa?.tp2?.pct || 40}%) \`${signal.tp2 || "—"}\` → +$${pa?.tp2?.amount ?? "?"}  R:R 1:${meta?.rrTp2 ?? "?"}`,
      `  TP3 (${pa?.tp3?.pct || 20}%) \`${signal.tp3 || "—"}\` → +$${pa?.tp3?.amount ?? "?"}  R:R 1:${meta?.rrTp3 ?? "?"}`,
      ``,
      `💰 Risk: $${meta?.riskAmount} → max reward: $${meta?.maxReward}`,
      ``,
      `*📐 Smart Money Levels:*`,
      signal.order_block    ? `  OB:  \`${signal.order_block}\`` : null,
      signal.fvg            ? `  FVG: \`${signal.fvg}\`` : null,
      signal.liquidity_level ? `  Liq: \`${signal.liquidity_level}\`` : null,
      signal.fibonacci_level ? `  Fib: \`${signal.fibonacci_level}\`` : null,
      ``,
      `*Model votes:*`,
      `  Trend    ${signal.trend_vote} ${signal.trend_conf}% — ${signal.trend_note || ""}`,
      `  S/R      ${signal.sr_vote} ${signal.sr_conf}% — ${signal.sr_note || ""}`,
      `  Momentum ${signal.momentum_vote} ${signal.momentum_conf}% — ${signal.momentum_note || ""}`,
      ``,
      `⚠️ *Invalidation:* ${signal.invalidation}`,
      isAPlus ? `\n🔥 *A+ signal — scale out: ${signal.partial_close || "30/40/30"}*` : null,
      ``,
      `_Tap to decide ↓_`,
    ].filter((l) => l !== null).join("\n");

    const keyboard = {
      inline_keyboard: [[
        { text: "✅  EXECUTE TRADE", callback_data: `exec_${id}` },
        { text: "❌  SKIP",          callback_data: `skip_${id}` },
      ]],
    };

    const res = await this.request("sendMessage", {
      chat_id:      this.chatId,
      text,
      parse_mode:   "Markdown",
      reply_markup: keyboard,
    });

    if (res?.result?.message_id) {
      this.pending.set(`exec_${id}`, {
        signal,
        messageId: res.result.message_id,
        onExecute,
      });
      this.pending.set(`skip_${id}`, {
        signal,
        messageId: res.result.message_id,
        onSkip,
      });

      // Auto-expire pending signal after 10 minutes
      setTimeout(() => {
        if (this.pending.has(`exec_${id}`)) {
          this.pending.delete(`exec_${id}`);
          this.pending.delete(`skip_${id}`);
          console.log(`[Telegram] Signal ${id} expired (no response in 10 min)`);
        }
      }, 10 * 60 * 1000);
    }

    return res;
  }

  // ─── LONG-POLL LISTENER ───────────────────────────────────────────────────

  startCallbackListener() {
    if (!this.enabled || this.polling) return;
    this.polling = true;
    console.log("[Telegram] Listening for button taps...");
    this._poll();
  }

  stopCallbackListener() {
    this.polling = false;
  }

  async _poll() {
    while (this.polling) {
      try {
        const data = await this.request("getUpdates", {
          offset:          this.pollOffset,
          timeout:         30,
          allowed_updates: ["callback_query"],
        });

        if (data?.result?.length) {
          for (const update of data.result) {
            this.pollOffset = update.update_id + 1;
            if (update.callback_query) {
              await this._handleCallback(update.callback_query);
            }
          }
        }
      } catch (err) {
        console.error("[Telegram] Poll error:", err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  async _handleCallback(cb) {
    const data      = cb.data;
    const messageId = cb.message?.message_id;
    const entry     = this.pending.get(data);

    // Always answer callback immediately — removes loading spinner on button
    await this.request("answerCallbackQuery", {
      callback_query_id: cb.id,
    });

    if (!entry) {
      await this._replaceButtons(messageId, "⏱ Signal already actioned or expired.");
      return;
    }

    // Remove both exec_ and skip_ for this signal so it can't be double-tapped
    const paired = data.startsWith("exec_")
      ? data.replace("exec_", "skip_")
      : data.replace("skip_", "exec_");
    this.pending.delete(data);
    this.pending.delete(paired);

    if (data.startsWith("exec_")) {
      await this._handleExecute(entry, messageId);
    } else {
      await this._handleSkip(entry, messageId);
    }
  }

  async _handleExecute(entry, messageId) {
    const { signal, onExecute } = entry;
    const asset   = signal.meta?.asset || "?";
    const verdict = signal.verdict;

    console.log(`[Telegram] ✅ EXECUTE tapped — ${verdict} ${asset}`);

    // Immediately remove buttons and show "placing..." so phone feels instant
    await this._replaceButtons(messageId, `⏳ Placing *${verdict}* order on *${asset}*...`);

    if (!onExecute) {
      await this.sendText("⚠️ No broker connected — set BROKER and wire onExecute.");
      return;
    }

    try {
      const result = await onExecute(signal);

      if (result?.success) {
        await this.sendText(
          `✅ *Order placed!*\n\n` +
          `${verdict} *${asset}*\n` +
          `Entry: \`${signal.entry}\`\n` +
          `SL: \`${signal.stop_loss}\`\n` +
          `TP: \`${signal.take_profit}\`\n` +
          `Order ID: \`${result.orderId}\``
        );
      } else if (result?.skipped) {
        await this.sendText(`⚠️ Broker skipped order: ${result.reason}`);
      } else {
        await this.sendText(`❌ Order failed: ${result?.error || "unknown error"}`);
      }
    } catch (err) {
      await this.sendText(`❌ Execution error: ${err.message}`);
    }
  }

  async _handleSkip(entry, messageId) {
    const { signal, onSkip } = entry;
    console.log(`[Telegram] ❌ SKIP tapped — ${signal.meta?.asset}`);
    await this._replaceButtons(
      messageId,
      `❌ *Skipped* — ${signal.meta?.asset} ${signal.verdict} signal passed.`
    );
    if (onSkip) onSkip(signal);
  }

  async _replaceButtons(messageId, text) {
    // Remove the inline keyboard first
    await this.request("editMessageReplyMarkup", {
      chat_id:      this.chatId,
      message_id:   messageId,
      reply_markup: { inline_keyboard: [] },
    });
    // Then send a follow-up status message
    await this.sendText(text);
  }

  // ─── HELPERS ─────────────────────────────────────────────────────────────

  async sendText(text) {
    if (!this.enabled) return null;
    return this.request("sendMessage", {
      chat_id:    this.chatId,
      text,
      parse_mode: "Markdown",
    });
  }

  async request(method, body = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(`${this.baseUrl}/${method}`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
        signal:  controller.signal,
      });
      const data = await res.json();
      if (!data.ok) {
        console.error(`[Telegram] ${method} failed:`, data.description);
      }
      return data;
    } catch (err) {
      const reason = err.name === "AbortError" ? "request timed out" : err.message;
      console.warn(`[Telegram] ${method} error: ${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
