// Markets from builder-deployed (HIP-3) perp dexs, with the asset ids orders need.
import { DEXS, PRE_IPO } from "../config";
import { metaAndAssetCtxs, perpDexs } from "./api";

export type Category = "stocks" | "preipo";

export interface Market {
  coin: string; // full name, e.g. "xyz:NVDA"
  dex: string;
  base: string; // "NVDA"
  asset: number; // id used in orders
  category: Category;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  markPx: number;
  midPx: number;
  prevDayPx: number;
  funding: number; // per hour
  openInterest: number; // in units
  dayNtlVlm: number; // USD
}

/** Asset id of a builder-deployed dex's asset: 100000 + dexIndex * 10000 + index in its universe. */
export const assetId = (dexIndex: number, indexInDex: number) => 100000 + dexIndex * 10000 + indexInDex;

export async function loadMarkets(): Promise<{ markets: Market[]; missing: string[] }> {
  const dexs = await perpDexs();
  const markets: Market[] = [];
  const missing: string[] = [];
  for (const dex of DEXS) {
    const dexIndex = dexs.findIndex((d) => d?.name === dex);
    if (dexIndex < 1) {
      missing.push(dex);
      continue;
    }
    const [meta, ctxs] = await metaAndAssetCtxs(dex);
    meta.universe.forEach((a, i) => {
      const ctx = ctxs[i];
      if (a.isDelisted || !ctx) return;
      const base = (a.name.includes(":") ? a.name.split(":")[1] : a.name).toUpperCase();
      const markPx = Number(ctx.markPx);
      markets.push({
        coin: a.name,
        dex,
        base,
        asset: assetId(dexIndex, i),
        category: PRE_IPO.has(base) ? "preipo" : "stocks",
        szDecimals: a.szDecimals,
        maxLeverage: a.maxLeverage,
        onlyIsolated: !!a.onlyIsolated,
        markPx,
        midPx: ctx.midPx ? Number(ctx.midPx) : markPx,
        prevDayPx: Number(ctx.prevDayPx),
        funding: Number(ctx.funding),
        openInterest: Number(ctx.openInterest),
        dayNtlVlm: Number(ctx.dayNtlVlm),
      });
    });
  }
  markets.sort((a, b) => b.dayNtlVlm - a.dayNtlVlm);
  return { markets, missing };
}
