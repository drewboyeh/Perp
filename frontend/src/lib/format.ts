import { Interface, formatUnits } from "ethers";
import { EXCHANGE_ABI } from "../config";

const exchangeInterface = new Interface(EXCHANGE_ABI);

/** Name of the exchange's custom error in a revert, whichever way the RPC nested the data. */
function revertName(e: unknown): string | undefined {
  const err = e as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const nested = (x: unknown) => (x && typeof x === "object" ? (x as { data?: unknown }).data : x);
  for (const data of [err?.data, nested(err?.data), err?.info?.error?.data, nested(err?.info?.error?.data), err?.error?.data]) {
    if (typeof data !== "string" || !data.startsWith("0x") || data.length < 10) continue;
    try {
      const parsed = exchangeInterface.parseError(data);
      if (parsed) return parsed.name;
    } catch {}
  }
  return undefined;
}

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
  const name = revertName(e);
  if (name) return name;
  const err = e as { shortMessage?: string; reason?: string; message?: string; info?: { error?: { message?: string } } };
  const msg = err?.shortMessage || err?.reason || err?.info?.error?.message || err?.message || String(e);
  return msg.replace(/^execution reverted: ?/, "").slice(0, 200);
}
