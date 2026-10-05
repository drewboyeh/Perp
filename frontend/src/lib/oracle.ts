import { HERMES_URL, deployment } from "../config";

/** Signed price updates to attach to a transaction (empty for push oracles). */
export async function getPriceUpdate(feedIds: string[]): Promise<string[]> {
  if (deployment?.oracleType !== "pyth" || feedIds.length === 0) return [];
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${qs}&encoding=hex`);
  if (!res.ok) throw new Error(`Price service error ${res.status}`);
  const body = (await res.json()) as { binary: { data: string[] } };
  return body.binary.data.map((d) => (d.startsWith("0x") ? d : `0x${d}`));
}

export interface PythFeed {
  id: string;
  symbol: string;
  description: string;
}

/** Search Pyth's catalogue of US equity feeds by ticker. */
export async function searchPythEquities(query: string): Promise<PythFeed[]> {
  const res = await fetch(`${HERMES_URL}/v2/price_feeds?query=${encodeURIComponent(query)}&asset_type=equity`);
  if (!res.ok) throw new Error(`Price service error ${res.status}`);
  const feeds = (await res.json()) as { id: string; attributes: Record<string, string> }[];
  return feeds
    .map((f) => ({
      id: f.id.startsWith("0x") ? f.id : `0x${f.id}`,
      symbol: f.attributes.symbol ?? f.attributes.base ?? "",
      description: f.attributes.description ?? "",
    }))
    .filter((f) => f.symbol.endsWith("/USD"));
}
