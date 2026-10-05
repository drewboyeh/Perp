import { useState } from "react";
import type { Market, PriceHistory } from "../hooks/useExchangeData";
import { fmtPrice } from "../lib/format";

interface Props {
  markets: Market[];
  selected?: number;
  onSelect: (id: number) => void;
  onList: () => void;
  history: PriceHistory;
}

export function MarketList({ markets, selected, onSelect, onList, history }: Props) {
  const [q, setQ] = useState("");
  const shown = markets.filter((m) => m.symbol.toLowerCase().includes(q.toLowerCase()));
  return (
    <aside className="panel market-list">
      <div className="panel-head">
        <h2>Markets</h2>
        <button className="btn small" onClick={onList}>
          + List a stock
        </button>
      </div>
      <input className="input search" placeholder="Search ticker" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {shown.map((m) => {
          const h = history[m.id] ?? [];
          const first = h[0]?.p;
          const change = first ? (Number(m.price) / 1e18 / first - 1) * 100 : 0;
          return (
            <li key={m.id}>
              <button className={`market-row ${selected === m.id ? "selected" : ""}`} onClick={() => onSelect(m.id)}>
                <span className="sym">
                  {m.symbol}
                  <span className="pair">-PERP</span>
                </span>
                <span className="px mono">{m.price ? fmtPrice(m.price) : "—"}</span>
                <span className={`chg mono ${change > 0 ? "up" : change < 0 ? "down" : "muted"}`}>
                  {!m.priceFresh ? <span className="tag">closed</span> : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`}
                </span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && <li className="empty">No markets match “{q}”.</li>}
      </ul>
    </aside>
  );
}
