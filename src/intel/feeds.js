/**
 * Free intel feeds — no API key required by any source here.
 *
 * These are CONTEXT, not signals. Nothing in this file should open a trade.
 * The justification is narrow: news tells you when NOT to be positioned
 * (a scheduled event, an exchange halt, a depeg), which is a veto, and vetoes
 * do not need a proven edge to be worth having.
 *
 * Anything that wants to be a signal has to earn it through source_calls /
 * source_scores: record a directional call, resolve it against price N hours
 * later, and only grant weight after >=30 resolved calls with a positive
 * Wilson lower bound. Until then weight stays 0.
 */

const UA = "trader-bot/1.0";

export class IntelFeeds {
  constructor({ cacheTtlMs = 10 * 60 * 1000, cryptoPanicKey = "" } = {}) {
    this.cacheTtlMs = cacheTtlMs;
    this.cryptoPanicKey = cryptoPanicKey;
    this.cache = new Map();
  }

  async _cached(key, fn) {
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.ts < this.cacheTtlMs) return hit.data;
    const data = await fn();
    this.cache.set(key, { ts: Date.now(), data });
    return data;
  }

  async _json(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.json();
  }

  async _text(url) {
    const res = await fetch(url, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`${res.status} ${url}`);
    return res.text();
  }

  // ── FEAR & GREED (no key) ─────────────────────────────────────────────────

  /**
   * Contrarian at the extremes only. The middle of the range carries no
   * information and should not be treated as a mild signal.
   */
  async fearGreed(limit = 30) {
    return this._cached(`fng:${limit}`, async () => {
      const d = await this._json(`https://api.alternative.me/fng/?limit=${limit}`);
      const rows = (d.data || []).map((x) => ({
        ts: Number(x.timestamp) * 1000,
        value: Number(x.value),
        label: x.value_classification,
      }));
      const now = rows[0];
      return {
        current: now?.value ?? null,
        label: now?.label ?? null,
        extreme: now ? (now.value <= 20 ? "extreme_fear" : now.value >= 80 ? "extreme_greed" : null) : null,
        history: rows,
      };
    });
  }

  // ── CRYPTOPANIC (free tier, key optional) ─────────────────────────────────

  async cryptoPanic(currencies = "BTC,ETH") {
    if (!this.cryptoPanicKey) return { available: false, posts: [] };
    return this._cached(`cp:${currencies}`, async () => {
      const url = `https://cryptopanic.com/api/v1/posts/?auth_token=${this.cryptoPanicKey}`
                + `&currencies=${currencies}&public=true`;
      const d = await this._json(url);
      return {
        available: true,
        posts: (d.results || []).map((p) => ({
          title: p.title,
          url: p.url,
          ts: Date.parse(p.published_at),
          source: p.source?.title || "unknown",
          votes: p.votes || {},
        })),
      };
    });
  }

  // ── RSS / REDDIT (no key) ─────────────────────────────────────────────────

  /**
   * Reddit's .json API blocks non-browser clients, but the Atom feed at
   * .rss serves fine with a plain UA. Community chatter: unweighted, noisy,
   * and contrarian at best. Context only.
   */
  async reddit(subreddit = "CryptoCurrency", sort = "hot", limit = 25) {
    return this._cached(`rd:${subreddit}:${sort}`, async () => {
      try {
        const xml = await this._text(
          `https://www.reddit.com/r/${subreddit}/${sort}.rss?limit=${limit}`
        );
        return parseFeedItems(xml, `reddit/${subreddit}`);
      } catch {
        return [];
      }
    });
  }

  async rss(url, source) {
    return this._cached(`rss:${url}`, async () => {
      try {
        const xml = await this._text(url);
        return parseFeedItems(xml, source);
      } catch {
        return [];
      }
    });
  }

  /** Everything, merged newest-first. Headlines only — no interpretation here. */
  async headlines({ subreddits = ["CryptoCurrency"], rssUrls = DEFAULT_RSS, currencies = "BTC,ETH" } = {}) {
    const jobs = [
      ...subreddits.map((s) => this.reddit(s)),
      ...rssUrls.map((r) => this.rss(r.url, r.source)),
      this.cryptoPanic(currencies).then((c) => c.posts),
    ];
    const results = await Promise.allSettled(jobs);
    return results
      .filter((r) => r.status === "fulfilled")
      .flatMap((r) => r.value)
      .filter((x) => x?.title)
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  }
}

export const DEFAULT_RSS = [
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", source: "coindesk" },
  { url: "https://cointelegraph.com/rss",                   source: "cointelegraph" },
  { url: "https://decrypt.co/feed",                         source: "decrypt" },
];

function parseFeedItems(xml, source) {
  const isAtom = /<entry[\s>]/i.test(xml);
  const blocks = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i).slice(1);

  const items = [];
  for (const b of blocks) {
    const title = clean(b.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
    if (!title) continue;

    const url = isAtom
      ? (b.match(/<link[^>]*href="([^"]+)"/i)?.[1] || "")
      : clean(b.match(/<link>([\s\S]*?)<\/link>/i)?.[1]);

    const date = b.match(/<pubDate>([\s\S]*?)<\/pubDate>/i)?.[1]
              || b.match(/<published>([\s\S]*?)<\/published>/i)?.[1]
              || b.match(/<updated>([\s\S]*?)<\/updated>/i)?.[1];

    items.push({ title, url, ts: date ? Date.parse(date) : Date.now(), source });
  }
  return items;
}

function clean(s) {
  if (!s) return "";
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
          .replace(/<[^>]+>/g, "")
          .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
          .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
          .trim();
}
