// Hyperliquid's price and size rules for perps (from the official SDK and docs):
//  - sizes have at most `szDecimals` decimals;
//  - prices have at most 5 significant figures and at most (6 - szDecimals) decimals,
//    except that integer prices are always allowed.

const stripZeros = (s: string) => (s.includes(".") ? s.replace(/\.?0+$/, "") : s);

/** Wire string for a perp price, rounded to Hyperliquid's tick rules. */
export function formatPrice(px: number, szDecimals: number): string {
  if (!(px > 0)) throw new Error(`Invalid price ${px}`);
  if (Number.isInteger(px)) return String(px);
  const sig = Number(px.toPrecision(5));
  const maxDecimals = Math.max(0, 6 - szDecimals);
  return stripZeros(sig.toFixed(maxDecimals));
}

/** Wire string for a size, rounded down to `szDecimals` so it never exceeds what was asked. */
export function formatSize(sz: number, szDecimals: number): string {
  const f = 10 ** szDecimals;
  const floored = Math.floor(sz * f + 1e-9) / f;
  return stripZeros(floored.toFixed(szDecimals));
}

/** Price for an IOC "market" order: mid moved by `slippage` against the trader, then rounded. */
export function slippagePrice(mid: number, isBuy: boolean, slippage: number, szDecimals: number): string {
  return formatPrice(mid * (isBuy ? 1 + slippage : 1 - slippage), szDecimals);
}

/** Builder fee in tenths of a basis point as the percent string approveBuilderFee expects, e.g. 30 -> "0.03%". */
export const feeToPercent = (tenthsBps: number) => `${stripZeros((tenthsBps / 1000).toFixed(3))}%`;

export const fmtUsd = (n: number, digits = 2) =>
  `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const fmtCompactUsd = (n: number) =>
  `$${Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n)}`;

export const fmtPx = (n: number) =>
  n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : n.toPrecision(Math.max(5, Math.floor(Math.log10(n)) + 3));

export const fmtPct = (n: number, digits = 2) => `${n >= 0 ? "+" : ""}${(n * 100).toFixed(digits)}%`;
