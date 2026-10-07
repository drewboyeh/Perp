// App configuration. Everything here can be overridden with VITE_* variables in .env files.

export type Network = "mainnet" | "testnet";

export const NETWORK: Network = import.meta.env.VITE_HL_NETWORK === "testnet" ? "testnet" : "mainnet";
export const IS_MAINNET = NETWORK === "mainnet";

export const API_URL: string =
  import.meta.env.VITE_HL_API_URL ?? (IS_MAINNET ? "https://api.hyperliquid.xyz" : "https://api.hyperliquid-testnet.xyz");
export const HL_APP_URL = IS_MAINNET ? "https://app.hyperliquid.xyz" : "https://app.hyperliquid-testnet.xyz";

export const APP_NAME: string = import.meta.env.VITE_APP_NAME ?? "Perp Stocks";

/**
 * Builder code: every order carries this address and fee, and Hyperliquid pays the fee to it.
 * The builder address needs at least 100 USDC in its Hyperliquid perps account to receive fees.
 */
export const BUILDER_ADDRESS = (import.meta.env.VITE_BUILDER_ADDRESS ?? "").toLowerCase();
/** Builder fee in tenths of a basis point: 30 = 3 bps = 0.03% of notional. Perps allow at most 100 (0.1%). */
export const BUILDER_FEE = Number(import.meta.env.VITE_BUILDER_FEE ?? 30);

/**
 * Builder-deployed (HIP-3) perp dexs to show, by name. "xyz" is Trade.xyz, which lists US stocks,
 * indices and pre-IPO companies. Add more comma-separated, e.g. "xyz,abc".
 */
export const DEXS: string[] = (import.meta.env.VITE_DEXS ?? "xyz")
  .split(",")
  .map((s: string) => s.trim())
  .filter(Boolean);

/**
 * Markets shown under "Pre-IPO", matched on the base ticker (the part after "dex:").
 * Listings change; edit this list (or VITE_PRE_IPO) to match what the dexs offer.
 */
export const PRE_IPO: Set<string> = new Set(
  (import.meta.env.VITE_PRE_IPO ?? "SPACEX,SPCX,OPENAI,ANTHROPIC,STRIPE,BYTEDANCE,DATABRICKS,XAI,ANDURIL,KRAKEN")
    .split(",")
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean),
);

/** Default slippage for market orders (IOC limit at mid ± this). */
export const DEFAULT_SLIPPAGE = 0.01;
