import { useState } from "react";
import type { ExchangeData, Market, Position } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { WAD, fmtNum, fmtPrice, fmtSignedUsd, fmtUsd, parseWad, toNum } from "../lib/format";
import { abs, withSlippage } from "../lib/math";
import { closePosition, deposit, modifyPosition } from "../lib/actions";
import { Modal } from "./Modal";

interface Props {
  data: ExchangeData;
  wallet: Wallet;
  tx: Tx;
  onSelect: (id: number) => void;
}

export function Positions({ data, wallet, tx, onSelect }: Props) {
  const [editing, setEditing] = useState<Position>();
  const positions = data.account?.positions ?? [];
  const marketOf = (id: number) => data.markets.find((m) => m.id === id)!;

  const close = (p: Position) => {
    const m = marketOf(p.marketId);
    const isBuy = p.size < 0n;
    return tx.run(`Close ${p.symbol}`, async () => {
      await closePosition(await wallet.getSigner(), p.marketId, m.feedId, withSlippage(p.markPrice, isBuy, 100n));
    });
  };

  return (
    <div className="panel positions">
      <div className="panel-head">
        <h2>Positions</h2>
        <span className="muted">{positions.length} open</span>
      </div>
      {!wallet.account ? (
        <p className="empty">Connect a wallet to see your positions.</p>
      ) : positions.length === 0 ? (
        <p className="empty">No open positions. Pick a stock and go long or short.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Market</th>
                <th>Size</th>
                <th>Entry</th>
                <th>Mark</th>
                <th>Liq. price</th>
                <th>Margin</th>
                <th>Leverage</th>
                <th>PnL</th>
                <th>Funding</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => {
                const pnlPct = p.margin ? (toNum(p.unrealizedPnl) / toNum(p.margin)) * 100 : 0;
                return (
                  <tr key={p.marketId} className={p.liquidatable ? "danger" : ""}>
                    <td>
                      <button className="link" onClick={() => onSelect(p.marketId)}>
                        {p.symbol}
                      </button>{" "}
                      <span className={`side-tag ${p.size > 0n ? "long" : "short"}`}>
                        {p.size > 0n ? "LONG" : "SHORT"}
                      </span>
                    </td>
                    <td className="mono">
                      {fmtNum(abs(p.size))}
                      <div className="sub">{fmtUsd(p.notional)}</div>
                    </td>
                    <td className="mono">{fmtPrice(p.entryPrice)}</td>
                    <td className="mono">{fmtPrice(p.markPrice)}</td>
                    <td className="mono down">{p.liquidationPrice ? fmtPrice(p.liquidationPrice) : "—"}</td>
                    <td className="mono">{fmtUsd(p.margin)}</td>
                    <td className="mono">{p.equity > 0n ? `${toNum(p.leverage).toFixed(2)}x` : "∞"}</td>
                    <td className={`mono ${p.unrealizedPnl >= 0n ? "up" : "down"}`}>
                      {fmtSignedUsd(p.unrealizedPnl)}
                      <div className="sub">{pnlPct.toFixed(2)}%</div>
                    </td>
                    <td className={`mono ${p.accruedFunding > 0n ? "down" : "up"}`}>{fmtSignedUsd(-p.accruedFunding, 4)}</td>
                    <td className="actions">
                      <button className="btn small ghost" disabled={tx.busy} onClick={() => setEditing(p)}>
                        Margin
                      </button>
                      <button className="btn small" disabled={tx.busy} onClick={() => close(p)}>
                        Close
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <MarginModal
          position={editing}
          market={marketOf(editing.marketId)}
          data={data}
          onClose={() => setEditing(undefined)}
          onSubmit={(delta) =>
            tx
              .run(`${delta > 0n ? "Add" : "Remove"} ${editing.symbol} margin`, async () => {
                const m = marketOf(editing.marketId);
                const s = await wallet.getSigner();
                const balance = data.account?.balance ?? 0n;
                if (delta > balance) {
                  // Top up the trading account from the wallet for the shortfall.
                  const scale = 10n ** BigInt(18 - data.tokenDecimals);
                  await deposit(s, (delta - balance + scale - 1n) / scale);
                }
                await modifyPosition(s, m.id, m.feedId, 0n, delta, 0n);
              })
              .then((ok) => ok && setEditing(undefined))
          }
        />
      )}
    </div>
  );
}

function MarginModal(props: {
  position: Position;
  market: Market;
  data: ExchangeData;
  onClose: () => void;
  onSubmit: (delta: bigint) => void;
}) {
  const [mode, setMode] = useState<"add" | "remove">("add");
  const [amount, setAmount] = useState("");
  const value = parseWad(amount);
  const { position: p } = props;
  return (
    <Modal title={`${p.symbol} margin`} onClose={props.onClose}>
      <div className="tabs">
        <button className={mode === "add" ? "active" : ""} onClick={() => setMode("add")}>
          Add
        </button>
        <button className={mode === "remove" ? "active" : ""} onClick={() => setMode("remove")}>
          Remove
        </button>
      </div>
      <label className="field">
        <span className="field-label">Amount (USD)</span>
        <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        <span className="field-hint">
          {mode === "add"
            ? `Account ${fmtUsd(props.data.account?.balance ?? 0n)} · any shortfall is deposited from your wallet`
            : `Position margin ${fmtUsd(p.margin)} · must stay above ${fmtUsd((p.notional * WAD) / props.market.params.maxLeverage)}`}
        </span>
      </label>
      <button className="btn block primary" disabled={value === 0n} onClick={() => props.onSubmit(mode === "add" ? value : -value)}>
        {mode === "add" ? "Add margin" : "Remove margin"}
      </button>
    </Modal>
  );
}
