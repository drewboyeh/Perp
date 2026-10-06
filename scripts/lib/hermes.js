// Pyth Hermes price service: signed price updates and equity feed lookup.
// Hermes requires an API key for price updates (Pyth Terminal); set PYTH_API_KEY.
const HERMES_URL = process.env.HERMES_URL || "https://hermes.pyth.network";
const { PYTH_API_KEY } = process.env;

async function getJson(path) {
  const headers = PYTH_API_KEY ? { Authorization: `Bearer ${PYTH_API_KEY}` } : {};
  // Never follow a redirect: it could forward the key to another host.
  const res = await fetch(`${HERMES_URL}${path}`, { headers, redirect: "error" });
  if (res.status === 401 && !PYTH_API_KEY) throw new Error("Hermes 401: set PYTH_API_KEY to a Pyth API key");
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  return res.json();
}

/** Signed updates for `feedIds`, ready to pass as `bytes[] priceUpdate`. */
async function getPythUpdateData(feedIds) {
  if (feedIds.length === 0) return [];
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const body = await getJson(`/v2/updates/price/latest?${qs}&encoding=hex`);
  return body.binary.data.map((d) => (d.startsWith("0x") ? d : `0x${d}`));
}

/** Signed updates plus parsed publish times: { data: bytes[], publishTimes: Map<feedId, seconds> }. */
async function getPythLatest(feedIds) {
  if (feedIds.length === 0) return { data: [], publishTimes: new Map() };
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const body = await getJson(`/v2/updates/price/latest?${qs}&encoding=hex&parsed=true`);
  const publishTimes = new Map(
    (body.parsed ?? []).map((p) => [`0x${p.id.replace(/^0x/, "")}`.toLowerCase(), Number(p.price.publish_time)]),
  );
  return { data: body.binary.data.map((d) => (d.startsWith("0x") ? d : `0x${d}`)), publishTimes };
}

/** Feed id of the regular-hours US equity feed for `ticker` (e.g. Equity.US.AAPL/USD), or undefined. */
async function findEquityFeed(ticker) {
  const feeds = await getJson(`/v2/price_feeds?query=${encodeURIComponent(ticker)}&asset_type=equity`);
  const want = `Equity.US.${ticker.toUpperCase()}/USD`;
  const hit = feeds.find((f) => f.attributes?.symbol === want);
  if (!hit) return undefined;
  return hit.id.startsWith("0x") ? hit.id : `0x${hit.id}`;
}

module.exports = { HERMES_URL, getPythUpdateData, getPythLatest, findEquityFeed };
