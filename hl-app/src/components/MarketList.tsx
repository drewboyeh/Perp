import { useState } from "react";
import type { Category, Market } from "../hl/markets";
import { fmtPct, fmtPx } from "../hl/format";

interface Props {
  markets: Market[];
  selected?: string;
  onSelect: (coin: string) => void;
}

const TABS: { id: Category; label: string }[] = [
  { id: "stocks", label: "Stocks" },
  { id: "preipo", label: "Pre-IPO" },
];

export function MarketList({ markets, selected, onSelect }: Props) {
  const [tab, setTab] = useState<Category>("stocks");
  const [q, setQ] = useState("");
  const shown = markets.filter((m) => m.category === tab && m.base.includes(q.trim().toUpperCase()));
  return (
    <aside className="panel market-list">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
            {t.label}
            <span className="count">{markets.filter((m) => m.category === t.id).length}</span>
          </button>
        ))}
      </div>
      <input className="input" placeholder="Search ticker" value={q} onChange={(e) => setQ(e.target.value)} />
      <ul>
        {shown.map((m) => {
          const change = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
          return (
            <li key={m.coin}>
              <button className={`market-row ${selected === m.coin ? "selected" : ""}`} onClick={() => onSelect(m.coin)}>
                <span className="sym">{m.base}</span>
                <span className="px mono">{fmtPx(m.markPx)}</span>
                <span className="lev muted">{m.maxLeverage}x</span>
                <span className={`chg mono ${change >= 0 ? "up" : "down"}`}>{fmtPct(change)}</span>
              </button>
            </li>
          );
        })}
        {shown.length === 0 && (
          <li className="empty muted">
            {tab === "preipo" && !q ? "No pre-IPO markets listed right now." : `Nothing matches “${q}”.`}
          </li>
        )}
      </ul>
    </aside>
  );
}
