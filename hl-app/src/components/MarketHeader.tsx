import type { Market } from "../hl/markets";
import { fmtCompactUsd, fmtPct, fmtPx } from "../hl/format";

export function MarketHeader({ market }: { market: Market }) {
  const change = market.prevDayPx ? market.markPx / market.prevDayPx - 1 : 0;
  const preIpo = market.category === "preipo";
  return (
    <section className="panel market-header">
      <div className="mh-top">
        <h1>
          {market.base}
          <span className="pair">-PERP</span>
          {preIpo && <span className="tag pre">Pre-IPO</span>}
        </h1>
        <div className="mh-price mono">${fmtPx(market.markPx)}</div>
        <div className={`mono ${change >= 0 ? "up" : "down"}`}>{fmtPct(change)} 24h</div>
      </div>
      <dl className="stats">
        <div>
          <dt>Funding / hr</dt>
          <dd className="mono">{fmtPct(market.funding, 4)}</dd>
        </div>
        <div>
          <dt>Open interest</dt>
          <dd className="mono">{fmtCompactUsd(market.openInterest * market.markPx)}</dd>
        </div>
        <div>
          <dt>24h volume</dt>
          <dd className="mono">{fmtCompactUsd(market.dayNtlVlm)}</dd>
        </div>
        <div>
          <dt>Max leverage</dt>
          <dd className="mono">{market.maxLeverage}x</dd>
        </div>
        <div>
          <dt>Venue</dt>
          <dd className="mono">{market.coin.split(":")[0]} on Hyperliquid</dd>
        </div>
      </dl>
      {preIpo && (
        <p className="note">
          Synthetic perpetual on a private company, priced by trading on this market. It can move sharply around
          funding rounds and the IPO. You never own shares, and the market isn't affiliated with the company.
        </p>
      )}
    </section>
  );
}
