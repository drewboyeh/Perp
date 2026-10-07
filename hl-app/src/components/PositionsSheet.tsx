import { useEffect, useState } from "react";
import { DEFAULT_SLIPPAGE } from "../config";
import type { Trading } from "../hooks";
import type { PositionData } from "../hl/api";
import { fmtPx, fmtUsd } from "../hl/format";
import type { Market } from "../hl/markets";
import { placeMarketOrder } from "../hl/trading";

export const baseOf = (coin: string) => (coin.includes(":") ? coin.split(":")[1] : coin);

interface Props {
  positions: PositionData[];
  accountValue: number;
  markets: Market[];
  trading: Trading;
  notify: (msg: string, kind?: "ok" | "err") => void;
  onPick: (coin: string) => void;
  onClose: () => void;
  onTraded: () => void;
}

/** Closes a whole position with a reduce-only market order. */
export async function closePosition(trading: Trading, market: Market, szi: number) {
  return trading.withAgent((agent) =>
    placeMarketOrder(agent, { market, isBuy: szi < 0, size: Math.abs(szi), reduceOnly: true, slippage: DEFAULT_SLIPPAGE }),
  );
}

export function PositionsSheet({ positions, accountValue, markets, trading, notify, onPick, onClose, onTraded }: Props) {
  const [closing, setClosing] = useState<string>();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const close = async (p: PositionData) => {
    const market = markets.find((m) => m.coin === p.coin);
    if (!market) return notify(`${baseOf(p.coin)} isn't shown in this app. Close it on Hyperliquid.`, "err");
    setClosing(p.coin);
    try {
      const fill = await closePosition(trading, market, Number(p.szi));
      notify(`Closed ${fill.totalSz} ${market.base} at $${fill.avgPx}`, "ok");
      onTraded();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setClosing(undefined);
    }
  };

  return (
    <div className="scrim" onClick={onClose}>
      <div className="sheet portfolio" role="dialog" aria-label="Your positions" onClick={(e) => e.stopPropagation()}>
        <header className="trade-head">
          <h2>{fmtUsd(accountValue)}</h2>
          <p>Account value across your positions and cash</p>
        </header>
        {positions.length === 0 ? (
          <p className="quiet">No open trades. Pick a market and tap Buy or Sell.</p>
        ) : (
          <ul className="pos-list">
            {positions.map((p) => {
              const szi = Number(p.szi);
              const pnl = Number(p.unrealizedPnl);
              return (
                <li key={p.coin} className="pos">
                  <button className="pos-main" onClick={() => onPick(p.coin)}>
                    <span className="pos-sym">{baseOf(p.coin)}</span>
                    <span className="pos-meta">
                      {szi > 0 ? "Bought" : "Sold"} {Math.abs(szi)} at ${fmtPx(Number(p.entryPx))} · {p.leverage.value}x
                    </span>
                  </button>
                  <span className={`pos-pnl ${pnl >= 0 ? "up" : "down"}`}>
                    {pnl >= 0 ? "+" : ""}
                    {fmtUsd(pnl)}
                  </span>
                  <button className="chip" disabled={closing === p.coin} onClick={() => close(p)}>
                    {closing === p.coin ? "Closing…" : "Close"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
