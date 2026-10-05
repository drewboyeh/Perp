import { useState } from "react";
import type { ExchangeData, Market, PendingOrder, Position } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { WAD, fmtNum, fmtPrice, fmtSignedUsd, fmtUsd, parseWad, toNum } from "../lib/format";
import { abs, withSlippage } from "../lib/math";
import { addMargin, cancelOrder, deposit, executeOrder } from "../lib/actions";
import { submitOrder } from "../lib/submitOrder";
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

  const orders = data.account?.orders ?? [];
  const keeperFee = data.orderConfig?.keeperFee ?? 0n;
  const hasOrder = (marketId: number) => orders.some((o) => o.marketId === marketId);

  const close = (p: Position) =>
    submitOrder(wallet, tx, data, {
      label: `Close ${p.symbol}`,
      market: marketOf(p.marketId),
      sizeDelta: -p.size,
      marginDelta: 0n,
      acceptablePrice: withSlippage(p.markPrice, p.size < 0n, 100n),
      reduceOnly: true,
      escrow: keeperFee,
    });

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
                      <button
                        className="btn small"
                        disabled={tx.busy || hasOrder(p.marketId)}
                        title={hasOrder(p.marketId) ? "An order is already pending in this market" : undefined}
                        onClick={() => close(p)}
                      >
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
      {orders.length > 0 && <Orders orders={orders} data={data} wallet={wallet} tx={tx} />}
      {editing && (
        <MarginModal
          position={editing}
          market={marketOf(editing.marketId)}
          data={data}
          onClose={() => setEditing(undefined)}
          onSubmit={(delta) => {
            const m = marketOf(editing.marketId);
            if (delta < 0n) {
              // Withdrawing margin raises risk, so it goes through the delayed-order flow.
              setEditing(undefined);
              return submitOrder(wallet, tx, data, {
                label: `Remove ${editing.symbol} margin`,
                market: m,
                sizeDelta: 0n,
                marginDelta: delta,
                acceptablePrice: 0n,
                escrow: keeperFee,
              });
            }
            return tx
              .run(`Add ${editing.symbol} margin`, async () => {
                const s = await wallet.getSigner();
                const balance = data.account?.balance ?? 0n;
                if (delta > balance) {
                  // Top up the trading account from the wallet for the shortfall.
                  const scale = 10n ** BigInt(18 - data.tokenDecimals);
                  await deposit(s, (delta - balance + scale - 1n) / scale);
                }
                await addMargin(s, m.id, m.feedId, delta);
              })
              .then((ok) => ok && setEditing(undefined));
          }}
        />
      )}
    </div>
  );
}

function describe(o: PendingOrder): { kind: string; cls: string } {
  if (o.reduceOnly) return { kind: "Close", cls: o.sizeDelta > 0n ? "long" : "short" };
  if (o.sizeDelta === 0n) return { kind: o.marginDelta > 0n ? "Add margin" : "Remove margin", cls: "" };
  return o.sizeDelta > 0n ? { kind: "Buy", cls: "long" } : { kind: "Sell", cls: "short" };
}

function Orders({ orders, data, wallet, tx }: { orders: PendingOrder[]; data: ExchangeData; wallet: Wallet; tx: Tx }) {
  const now = data.chainNow();
  const feedOf = (id: number) => data.markets.find((m) => m.id === id)!.feedId;
  return (
    <div className="orders">
      <div className="panel-head">
        <h2>Pending orders</h2>
        <span className="muted small">Executed by keepers at the next oracle price</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Market</th>
              <th>Type</th>
              <th>Size</th>
              <th>Margin</th>
              <th>Limit price</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {orders.map((o) => {
              const d = describe(o);
              const expired = now > o.expiresAt;
              const ready = now >= o.executableAt && !expired;
              const limit =
                o.sizeDelta === 0n
                  ? "—"
                  : o.sizeDelta > 0n
                    ? o.acceptablePrice >= 10n ** 40n
                      ? "Market"
                      : `≤ ${fmtPrice(o.acceptablePrice)}`
                    : o.acceptablePrice === 0n
                      ? "Market"
                      : `≥ ${fmtPrice(o.acceptablePrice)}`;
              return (
                <tr key={o.marketId}>
                  <td>{o.symbol}</td>
                  <td>
                    <span className={`side-tag ${d.cls}`}>{d.kind.toUpperCase()}</span>
                  </td>
                  <td className="mono">{o.sizeDelta === 0n ? "—" : fmtNum(abs(o.sizeDelta))}</td>
                  <td className="mono">{o.marginDelta === 0n ? "—" : fmtSignedUsd(o.marginDelta)}</td>
                  <td className="mono">{limit}</td>
                  <td className="small">
                    {expired ? (
                      <span className="down">Expired</span>
                    ) : ready ? (
                      <span className="status-live">Executing…</span>
                    ) : (
                      <span className="muted">Ready in {o.executableAt - now}s</span>
                    )}
                    {!expired && <div className="sub">expires in {o.expiresAt - now}s</div>}
                  </td>
                  <td className="actions">
                    {ready && (
                      <button
                        className="btn small ghost"
                        disabled={tx.busy}
                        title="No keeper yet? Execute it yourself and keep the keeper fee."
                        onClick={() =>
                          tx.run(`Execute ${o.symbol} order`, async () =>
                            executeOrder(await wallet.getSigner(), o.marketId, feedOf(o.marketId), wallet.account!),
                          )
                        }
                      >
                        Execute
                      </button>
                    )}
                    {expired && (
                      <button
                        className="btn small"
                        disabled={tx.busy}
                        onClick={() =>
                          tx.run(`Cancel ${o.symbol} order`, async () =>
                            cancelOrder(await wallet.getSigner(), o.marketId, wallet.account!),
                          )
                        }
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
          {mode === "remove" && "Margin withdrawals execute like orders, after the next oracle price. "}
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
