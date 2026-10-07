// Minimal Hyperliquid HTTP client: the /info read endpoint and the /exchange write endpoint.
import { API_URL } from "../config";
import type { HlSignature } from "./signing";

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Hyperliquid ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export const info = <T>(body: Record<string, unknown>) => post<T>("/info", body);

export interface PerpDex {
  name: string;
  fullName?: string;
  deployer?: string;
}

export interface AssetMeta {
  name: string; // "xyz:NVDA" on builder-deployed dexs
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isDelisted?: boolean;
}

export interface AssetCtx {
  markPx: string;
  midPx: string | null;
  oraclePx: string;
  prevDayPx: string;
  funding: string;
  openInterest: string;
  dayNtlVlm: string;
}

export interface PositionData {
  coin: string;
  szi: string;
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  marginUsed: string;
  leverage: { type: "cross" | "isolated"; value: number };
}

export interface ClearinghouseState {
  marginSummary: { accountValue: string; totalNtlPos: string; totalMarginUsed: string };
  withdrawable: string;
  assetPositions: { position: PositionData }[];
}

/** perpDexs returns null for the first (validator-run) dex, then builder-deployed dexs in index order. */
export const perpDexs = () => info<(PerpDex | null)[]>({ type: "perpDexs" });

export const metaAndAssetCtxs = (dex: string) =>
  info<[{ universe: AssetMeta[] }, AssetCtx[]]>({ type: "metaAndAssetCtxs", dex });

export const clearinghouseState = (user: string, dex: string) =>
  info<ClearinghouseState>({ type: "clearinghouseState", user, dex });

export type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d" | "1w";

export interface Candle {
  t: number; // open time, ms
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
}

export const candleSnapshot = (coin: string, interval: Interval, startTime: number, endTime = Date.now()) =>
  info<Candle[]>({ type: "candleSnapshot", req: { coin, interval, startTime, endTime } });

/** Approved max builder fee for `user` and `builder`, in tenths of a basis point (0 if none). */
export const maxBuilderFee = (user: string, builder: string) =>
  info<number>({ type: "maxBuilderFee", user, builder });

export interface ExchangeResponse {
  status: "ok" | "err";
  response:
    | string
    | {
        type: string;
        data?: { statuses?: ({ filled: { totalSz: string; avgPx: string } } | { resting: { oid: number } } | { error: string })[] };
      };
}

export async function exchange(action: unknown, nonce: number, signature: HlSignature, vaultAddress: string | null = null) {
  const res = await post<ExchangeResponse>("/exchange", { action, nonce, signature, vaultAddress });
  if (res.status !== "ok") throw new Error(typeof res.response === "string" ? res.response : "Request rejected");
  const statuses = typeof res.response === "string" ? undefined : res.response.data?.statuses;
  const failed = statuses?.find((s): s is { error: string } => "error" in s);
  if (failed) throw new Error(failed.error);
  return res;
}
