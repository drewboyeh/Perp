// Live US stock quotes from free market-data APIs, for MockOracle deployments on testnets.
//
// Sources (each needs its own free key):
//  - finnhub: FINNHUB_API_KEY. Real-time quotes, ~60 requests/minute on the free tier.
//  - alpaca:  ALPACA_API_KEY_ID + ALPACA_API_SECRET_KEY. Real-time IEX trades on the free tier.
//
// Every ticker tries PRICE_SOURCES in order (default: finnhub, then alpaca when its keys are set).
// Override per ticker with PRICE_SOURCES_<TICKER>, e.g. PRICE_SOURCES_TSLA=alpaca,finnhub.
// A quote only counts if it is younger than MAX_QUOTE_AGE_S (default 120s), so prices stop
// updating when the market closes and on-chain trading pauses on its own.
const FINNHUB_URL = process.env.FINNHUB_URL || "https://finnhub.io/api/v1";
const ALPACA_DATA_URL = process.env.ALPACA_DATA_URL || "https://data.alpaca.markets";
const MAX_QUOTE_AGE_S = Number(process.env.MAX_QUOTE_AGE_S || 120);
const { FINNHUB_API_KEY, ALPACA_API_KEY_ID, ALPACA_API_SECRET_KEY } = process.env;

async function getJson(url, headers) {
  // Never follow a redirect: it could forward the API key to another host.
  const res = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`${new URL(url).host} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

const SOURCES = {
  finnhub: {
    configured: () => !!FINNHUB_API_KEY,
    async quote(ticker) {
      const q = await getJson(`${FINNHUB_URL}/quote?symbol=${encodeURIComponent(ticker)}`, {
        "X-Finnhub-Token": FINNHUB_API_KEY,
      });
      if (!q.c || !q.t) return undefined; // unknown symbol
      return { price: q.c, time: q.t };
    },
  },
  alpaca: {
    configured: () => !!(ALPACA_API_KEY_ID && ALPACA_API_SECRET_KEY),
    async quote(ticker) {
      const body = await getJson(
        `${ALPACA_DATA_URL}/v2/stocks/${encodeURIComponent(ticker)}/trades/latest?feed=iex`,
        { "APCA-API-KEY-ID": ALPACA_API_KEY_ID, "APCA-API-SECRET-KEY": ALPACA_API_SECRET_KEY },
      );
      if (!body.trade?.p) return undefined;
      return { price: body.trade.p, time: Math.floor(Date.parse(body.trade.t) / 1000) };
    },
  },
};

function sourcesFor(ticker) {
  const list = process.env[`PRICE_SOURCES_${ticker.toUpperCase().replace(/\W/g, "_")}`] || process.env.PRICE_SOURCES;
  const names = list
    ? list.split(",").map((s) => s.trim().toLowerCase())
    : Object.keys(SOURCES).filter((n) => SOURCES[n].configured());
  for (const n of names) {
    if (!SOURCES[n]) throw new Error(`Unknown price source "${n}" (use ${Object.keys(SOURCES).join(", ")})`);
    if (!SOURCES[n].configured()) throw new Error(`Price source "${n}" is missing its API key`);
  }
  if (names.length === 0) throw new Error("No price source configured: set FINNHUB_API_KEY (or the Alpaca keys)");
  return names;
}

/**
 * Latest fresh quote for `ticker` from its first source that has one:
 * `{ price, time, source }`, or `{ error }` describing why none was usable.
 */
async function getQuote(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const errors = [];
  for (const name of sourcesFor(ticker)) {
    try {
      const q = await SOURCES[name].quote(ticker);
      if (!q) errors.push(`${name}: no such symbol`);
      else if (now - q.time > MAX_QUOTE_AGE_S) errors.push(`${name}: last trade ${now - q.time}s ago`);
      else return { ...q, source: name };
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
    }
  }
  return { error: errors.join("; ") };
}

/** True during regular US equity hours (9:30-16:00 New York time, Mon-Fri). Holidays show up as stale quotes. */
function usMarketOpen(date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      weekday: "short",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  if (parts.weekday === "Sat" || parts.weekday === "Sun") return false;
  const minutes = Number(parts.hour) * 60 + Number(parts.minute);
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

module.exports = { getQuote, usMarketOpen, sourcesFor };
