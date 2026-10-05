// Fetches signed Pyth price updates from Hermes for pull-oracle deployments.
const HERMES_URL = process.env.HERMES_URL || "https://hermes.pyth.network";

async function getPythUpdateData(feedIds) {
  if (feedIds.length === 0) return [];
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${qs}&encoding=hex`);
  if (!res.ok) throw new Error(`Hermes ${res.status}: ${await res.text()}`);
  const body = await res.json();
  return body.binary.data.map((d) => (d.startsWith("0x") ? d : `0x${d}`));
}

module.exports = { getPythUpdateData };
