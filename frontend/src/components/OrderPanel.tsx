import { useMemo, useState } from "react";
import type { Market, ExchangeData } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { WAD, fmtNum, fmtPrice, fmtUsd, parseWad, toNum } from "../lib/format";
import { abs, liquidationPrice, notionalFor, sizeFor, withSlippage } from "../lib/math";
import { submitOrder } from "../lib/submitOrder";

interface Props {
  market: Market;
  data: ExchangeData;
  wallet: Wallet;
  tx: Tx;
}

/** Mirrors PerpExchange._fillPrice so quotes need no RPC round-trip. */
function fillPrice(m: Market, sizeDelta: bigint): bigint {
  const skew = m.longOpenInterest - m.shortOpenInterest;
  const avg = skew + sizeDelta / 2n;
  let premium = (avg * m.price) / m.params.skewScale;
  const max = WAD / 10n;
  if (premium > max) premium = max;
  if (premium < -max) premium = -max;
  return (m.price * (WAD + premium)) / WAD;
}

export function OrderPanel({ market, data, wallet, tx }: Props) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [marginIn, setMarginIn] = useState("100");
  const [leverage, setLeverage] = useState(5);
  const [slippageBps, setSlippageBps] = useState(50);

  const maxLev = toNum(market.params.maxLeverage);
  const lev = Math.min(leverage, maxLev);
  const scale = 10n ** BigInt(18 - data.tokenDecimals);
  const existing = data.account?.positions.find((p) => p.marketId === market.id);
  const pending = data.account?.orders.find((o) => o.marketId === market.id);
  const keeperFee = data.orderConfig?.keeperFee ?? 0n;

  const o = useMemo(() => {
    const margin = parseWad(marginIn);
    // Stay 1% under the cap so the skew premium can't tip the order over max leverage.
    const effLev = Math.min(lev, maxLev * 0.99);
    const levWad = BigInt(Math.round(effLev * 1e4)) * 10n ** 14n;
    const notional = notionalFor(margin, levWad, market.params.takerFee);
    const unsigned = sizeFor(notional, market.price);
    const size = side === "long" ? unsigned : -unsigned;
    const fill = size === 0n ? market.price : fillPrice(market, size);
    const fee = (((abs(size) * fill) / WAD) * market.params.takerFee) / WAD;
    const liq = liquidationPrice(size, fill, margin - fee, market.params.maintenanceMargin);
    const acceptable = withSlippage(fill, side === "long", BigInt(slippageBps));
    const escrow = margin + keeperFee;
    const accountBal = data.account?.balance ?? 0n;
    const shortfall = escrow > accountBal ? escrow - accountBal : 0n;
    const shortfallTokens = (shortfall + scale - 1n) / scale;
    return { margin, notional, size, fill, fee, liq, acceptable, escrow, shortfallTokens };
  }, [marginIn, lev, maxLev, side, market, slippageBps, data.account?.balance, scale, keeperFee]);

  const minMargin = data.risk?.minPositionMargin ?? 0n;
  const walletBal = data.account?.walletBalance ?? 0n;
  let disabledReason = "";
  if (!wallet.account) disabledReason = "Connect wallet";
  else if (!market.active) disabledReason = "Market is close-only";
  else if (!market.priceFresh) disabledReason = "Market closed (stale price)";
  else if (o.margin < minMargin) disabledReason = `Min margin ${fmtUsd(minMargin, 0)}`;
  else if (o.shortfallTokens > walletBal) disabledReason = "Insufficient funds";
  else if (pending) disabledReason = "Order pending in this market";

  const submit = () =>
    submitOrder(wallet, tx, data, {
      label: `${side === "long" ? "Long" : "Short"} ${fmtNum(abs(o.size))} ${market.symbol}`,
      market,
      sizeDelta: o.size,
      marginDelta: o.margin,
      acceptablePrice: o.acceptable,
      escrow: o.escrow,
    });

  const levMarks = [1, 2, 5, 10, 20, 50, 100].filter((x) => x <= maxLev);
  return (
    <aside className="panel order">
      <div className="side-toggle" role="tablist">
        <button className={`long ${side === "long" ? "active" : ""}`} onClick={() => setSide("long")}>
          Long
        </button>
        <button className={`short ${side === "short" ? "active" : ""}`} onClick={() => setSide("short")}>
          Short
        </button>
      </div>

      <label className="field">
        <span className="field-label">
          Margin <span className="muted">USD</span>
        </span>
        <input
          className="input mono"
          inputMode="decimal"
          value={marginIn}
          onChange={(e) => setMarginIn(e.target.value)}
        />
        <span className="field-hint">
          Account {fmtUsd(data.account?.balance ?? 0n)} · Wallet{" "}
          {fmtUsd(walletBal * scale)}
        </span>
      </label>

      <div className="field">
        <span className="field-label">
          Leverage <span className="lev-value mono">{lev.toFixed(1)}x</span>
        </span>
        <input
          type="range"
          min={1}
          max={maxLev}
          step={0.5}
          value={lev}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className={`slider ${side}`}
        />
        <div className="lev-marks">
          {levMarks.map((x) => (
            <button key={x} onClick={() => setLeverage(x)} className={lev === x ? "active" : ""}>
              {x}x
            </button>
          ))}
        </div>
      </div>

      <dl className="summary">
        <div>
          <dt>Position size</dt>
          <dd className="mono">
            {fmtNum(abs(o.size))} {market.symbol}
          </dd>
        </div>
        <div>
          <dt>Notional</dt>
          <dd className="mono">{fmtUsd(o.notional)}</dd>
        </div>
        <div>
          <dt>Est. fill price</dt>
          <dd className="mono">${fmtPrice(o.fill)}</dd>
        </div>
        <div>
          <dt>Fee</dt>
          <dd className="mono">{fmtUsd(o.fee)}</dd>
        </div>
        <div>
          <dt>Keeper fee</dt>
          <dd className="mono">{fmtUsd(keeperFee)}</dd>
        </div>
        <div>
          <dt>Liquidation price</dt>
          <dd className="mono down">{o.liq ? `$${fmtPrice(o.liq)}` : "—"}</dd>
        </div>
        <div>
          <dt>Slippage tolerance</dt>
          <dd>
            <select className="select" value={slippageBps} onChange={(e) => setSlippageBps(Number(e.target.value))}>
              {[10, 30, 50, 100, 300].map((b) => (
                <option key={b} value={b}>
                  {b / 100}%
                </option>
              ))}
            </select>
          </dd>
        </div>
      </dl>

      <p className="note">
        Orders fill {data.orderConfig?.minDelay ?? 1}s+ after you submit, at the next oracle price, so nobody can
        trade on a stale quote. Fills worse than your slippage limit are rejected and refunded.
      </p>
      {o.shortfallTokens > 0n && !disabledReason && (
        <p className="note">Deposits {fmtUsd(o.shortfallTokens * scale)} from your wallet first.</p>
      )}
      {existing && <p className="note">Merges into your open {market.symbol} position.</p>}

      <button
        className={`btn block ${side === "long" ? "long" : "short"}`}
        disabled={!!disabledReason || tx.busy}
        onClick={wallet.account ? submit : wallet.connect}
      >
        {disabledReason && wallet.account
          ? disabledReason
          : !wallet.account
            ? "Connect wallet"
            : `${side === "long" ? "Long" : "Short"} ${market.symbol} ${lev.toFixed(1)}x`}
      </button>
    </aside>
  );
}
