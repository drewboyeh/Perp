import { useState } from "react";
import { DEFAULT_SLIPPAGE } from "../config";
import type { Account } from "../hooks";
import { fmtPx, fmtUsd } from "../hl/format";
import type { Market } from "../hl/markets";
import { loadAgent, placeMarketOrder } from "../hl/trading";

interface Props {
  user?: string;
  account?: Account;
  markets: Market[];
  onSelect: (coin: string) => void;
  notify: (msg: string, kind?: "ok" | "err") => void;
  onTraded: () => void;
}

export function Positions({ user, account, markets, onSelect, notify, onTraded }: Props) {
  const [closing, setClosing] = useState<string>();
  const rows = Object.values(account?.byDex ?? {}).flatMap((s) =>
    s.assetPositions.map((p) => p.position).filter((p) => Number(p.szi) !== 0),
  );

  const close = async (coin: string, szi: number) => {
    const market = markets.find((m) => m.coin === coin);
    const agent = user ? loadAgent(user) : null;
    if (!market || !agent) return notify("Enable trading first (in the order panel).", "err");
    setClosing(coin);
    try {
      const fill = await placeMarketOrder(agent, {
        market,
        isBuy: szi < 0,
        size: Math.abs(szi),
        reduceOnly: true,
        slippage: DEFAULT_SLIPPAGE,
      });
      notify(`Closed ${fill.totalSz} ${market.base} at $${fill.avgPx}`, "ok");
      onTraded();
    } catch (e) {
      notify(`Close failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setClosing(undefined);
    }
  };

  return (
    <section className="panel positions">
      <h2>
        Positions <span className="muted">{rows.length}</span>
      </h2>
      {!user ? (
        <p className="empty muted">Connect a wallet to see your positions.</p>
      ) : rows.length === 0 ? (
        <p className="empty muted">No open positions.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Value</th>
                <th>PnL</th>
                <th>Liq. price</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const szi = Number(p.szi);
                const pnl = Number(p.unrealizedPnl);
                const base = p.coin.includes(":") ? p.coin.split(":")[1] : p.coin;
                return (
                  <tr key={p.coin}>
                    <td>
                      <button className="link" onClick={() => onSelect(p.coin)}>
                        {base}
                      </button>{" "}
                      <span className={`side-tag ${szi > 0 ? "long" : "short"}`}>
                        {szi > 0 ? "LONG" : "SHORT"} {p.leverage.value}x
                      </span>
                    </td>
                    <td className="mono">{Math.abs(szi)}</td>
                    <td className="mono">${fmtPx(Number(p.entryPx))}</td>
                    <td className="mono">{fmtUsd(Number(p.positionValue))}</td>
                    <td className={`mono ${pnl >= 0 ? "up" : "down"}`}>{fmtUsd(pnl)}</td>
                    <td className="mono">{p.liquidationPx ? `$${fmtPx(Number(p.liquidationPx))}` : "—"}</td>
                    <td>
                      <button className="btn small" disabled={closing === p.coin} onClick={() => close(p.coin, szi)}>
                        {closing === p.coin ? "Closing…" : "Close"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
