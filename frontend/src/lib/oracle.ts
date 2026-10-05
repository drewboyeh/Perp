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

export interface LivePrice {
  price: bigint; // 18 decimals
  publishTime: number;
}

/** Latest Pyth prices straight from Hermes, keyed by lower-case feed id (pull-oracle deployments). */
export async function getLivePrices(feedIds: string[]): Promise<Map<string, LivePrice>> {
  const out = new Map<string, LivePrice>();
  if (deployment?.oracleType !== "pyth" || feedIds.length === 0) return out;
  const qs = feedIds.map((id) => `ids[]=${id}`).join("&");
  const res = await fetch(`${HERMES_URL}/v2/updates/price/latest?${qs}&parsed=true&encoding=hex`);
  if (!res.ok) throw new Error(`Price service error ${res.status}`);
  const body = (await res.json()) as {
    parsed?: { id: string; price: { price: string; expo: number; publish_time: number } }[];
  };
  for (const p of body.parsed ?? []) {
    const shift = 18 + p.price.expo;
    if (shift < 0) continue;
    out.set(`0x${p.id.replace(/^0x/, "")}`.toLowerCase(), {
      price: BigInt(p.price.price) * 10n ** BigInt(shift),
      publishTime: Number(p.price.publish_time),
    });
  }
  return out;
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
