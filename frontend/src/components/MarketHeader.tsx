import type { Market } from "../hooks/useExchangeData";
import { fmtCompactUsd, fmtPrice, toNum } from "../lib/format";

export function MarketHeader({ market, now }: { market: Market; now: number }) {
  const longUsd = (market.longOpenInterest * market.price) / 10n ** 18n;
  const shortUsd = (market.shortOpenInterest * market.price) / 10n ** 18n;
  const fundingDaily = toNum(market.fundingRate) * 100;
  const age = Math.max(0, now - market.publishTime);
  return (
    <div className="panel market-header">
      <div className="mh-title">
        <h1>
          {market.symbol}
          <span className="pair">-PERP</span>
        </h1>
        <span className={`status ${market.priceFresh ? "open" : "closed"}`}>
          {!market.active ? "Close-only" : market.priceFresh ? "Market open" : "Market closed"}
        </span>
      </div>
      <div className="mh-price mono">${market.price ? fmtPrice(market.price) : "—"}</div>
      <dl className="stats">
        <div>
          <dt>Oracle age</dt>
          <dd className="mono">{market.publishTime ? `${age}s` : "—"}</dd>
        </div>
        <div>
          <dt>Funding / day</dt>
          <dd className={`mono ${fundingDaily > 0 ? "down" : fundingDaily < 0 ? "up" : ""}`}>
            {fundingDaily.toFixed(4)}%
          </dd>
        </div>
        <div>
          <dt>Open interest (L / S)</dt>
          <dd className="mono">
            <span className="up">{fmtCompactUsd(longUsd)}</span> / <span className="down">{fmtCompactUsd(shortUsd)}</span>
          </dd>
        </div>
        <div>
          <dt>Max leverage</dt>
          <dd className="mono">{toNum(market.params.maxLeverage)}x</dd>
        </div>
        <div>
          <dt>Taker fee</dt>
          <dd className="mono">{(toNum(market.params.takerFee) * 100).toFixed(2)}%</dd>
        </div>
      </dl>
    </div>
  );
}
