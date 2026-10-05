import { formatUnits } from "ethers";

export const WAD = 10n ** 18n;

export function toNum(wad: bigint, decimals = 18): number {
  return Number(formatUnits(wad, decimals));
}

export function fmtUsd(wad: bigint, digits = 2): string {
  const n = toNum(wad);
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

export function fmtSignedUsd(wad: bigint, digits = 2): string {
  return wad > 0n ? `+${fmtUsd(wad, digits)}` : fmtUsd(wad, digits);
}

export function fmtPrice(wad: bigint): string {
  const n = toNum(wad);
  const digits = n >= 1000 ? 2 : n >= 1 ? 2 : 4;
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function fmtNum(wad: bigint, digits = 4): string {
  return toNum(wad).toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtCompactUsd(wad: bigint): string {
  return "$" + Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 2 }).format(toNum(wad));
}

export function fmtPct(wad: bigint, digits = 2): string {
  return `${(toNum(wad) * 100).toFixed(digits)}%`;
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/** Parse a user-entered decimal into a WAD bigint; returns 0n for invalid input. */
export function parseWad(input: string, decimals = 18): bigint {
  const s = input.trim();
  if (!/^\d*\.?\d*$/.test(s) || s === "" || s === ".") return 0n;
  const [i, f = ""] = s.split(".");
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt((f + "0".repeat(decimals)).slice(0, decimals) || "0");
}

export function errorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; reason?: string; message?: string; info?: { error?: { message?: string } } };
  const msg = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || String(e);
  return msg.replace(/^execution reverted: ?/, "").slice(0, 200);
}
