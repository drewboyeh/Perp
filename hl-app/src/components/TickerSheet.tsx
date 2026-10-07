import { useEffect, useRef, useState } from "react";
import type { Market } from "../hl/markets";
import { fmtPct, fmtPx } from "../hl/format";

interface Props {
  markets: Market[];
  current?: string;
  onPick: (coin: string) => void;
  onClose: () => void;
}

export function TickerSheet({ markets, current, onPick, onClose }: Props) {
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const match = markets.filter((m) => m.base.includes(q.trim().toUpperCase()));
  const groups: [string, Market[]][] = [
    ["Stocks", match.filter((m) => m.category === "stocks")],
    ["Pre-IPO", match.filter((m) => m.category === "preipo")],
  ];

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet tickers" role="dialog" aria-label="Choose a market" onClick={(e) => e.stopPropagation()}>
        <input
          ref={input}
          className="search"
          placeholder="Search NVDA, TSLA, OPENAI…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && match[0] && onPick(match[0].coin)}
        />
        <div className="ticker-groups">
          {groups.map(([title, list]) =>
            list.length ? (
              <section key={title}>
                <h3>
                  {title === "Pre-IPO" && <span className="dot" aria-hidden />}
                  {title}
                </h3>
                <ul>
                  {list.map((m) => {
                    const change = m.prevDayPx ? m.markPx / m.prevDayPx - 1 : 0;
                    return (
                      <li key={m.coin}>
                        <button
                          className={`ticker-row ${m.coin === current ? "current" : ""}`}
                          onClick={() => onPick(m.coin)}
                        >
                          <span className="t-sym">{m.base}</span>
                          <span className="t-px">${fmtPx(m.markPx)}</span>
                          <span className={`t-chg ${change >= 0 ? "up" : "down"}`}>{fmtPct(change)}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null,
          )}
          {match.length === 0 && <p className="quiet">No market called “{q}”. Try a ticker like NVDA.</p>}
        </div>
      </div>
    </div>
  );
}
