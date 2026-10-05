import { WAD } from "./format";

const abs = (x: bigint) => (x < 0n ? -x : x);

/**
 * Notional such that margin left after the taker fee supports it at `leverage`:
 * N = L * (M - N * fee)  =>  N = L * M / (1 + L * fee)
 */
export function notionalFor(margin: bigint, leverage: bigint, takerFee: bigint): bigint {
  if (margin <= 0n || leverage <= 0n) return 0n;
  return (leverage * margin) / (WAD + (leverage * takerFee) / WAD);
}

export function sizeFor(notional: bigint, price: bigint): bigint {
  return price === 0n ? 0n : (notional * WAD) / price;
}

/** Mirrors PerpExchange._liquidationPrice. */
export function liquidationPrice(size: bigint, entry: bigint, margin: bigint, mm: bigint): bigint {
  if (size === 0n) return 0n;
  let num: bigint;
  let den: bigint;
  if (size > 0n) {
    num = (size * entry) / WAD - margin;
    den = (size * (WAD - mm)) / WAD;
  } else {
    num = margin + (abs(size) * entry) / WAD;
    den = (abs(size) * (WAD + mm)) / WAD;
  }
  if (num <= 0n || den <= 0n) return 0n;
  return (num * WAD) / den;
}

export function withSlippage(price: bigint, isBuy: boolean, bps: bigint): bigint {
  return isBuy ? (price * (10_000n + bps)) / 10_000n : (price * (10_000n - bps)) / 10_000n;
}

export { abs };
