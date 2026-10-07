import { useEffect, useState } from "react";
import { BUILDER_ADDRESS, BUILDER_FEE, DEFAULT_SLIPPAGE, HL_APP_URL } from "../config";
import type { Trading } from "../hooks";
import { feeToPercent, fmtUsd } from "../hl/format";
import type { Market } from "../hl/markets";
import { placeMarketOrder, updateLeverage } from "../hl/trading";

export type Side = "buy" | "sell";

interface Props {
  side: Side;
  market: Market;
  user?: string;
  available: number; // USDC free on this market's dex
  trading: Trading;
  connect: () => Promise<void>;
  notify: (msg: string, kind?: "ok" | "err") => void;
  onClose: () => void;
  onTraded: () => void;
}

const AMOUNTS = [25, 100, 500];
const LEVERAGES = [1, 2, 3, 5, 10, 20, 50];

export function TradeSheet({ side, market, user, available, trading, connect, notify, onClose, onTraded }: Props) {
  const [amount, setAmount] = useState("100");
  const levs = [...new Set([...LEVERAGES.filter((l) => l < market.maxLeverage), market.maxLeverage])];
  const [lev, setLev] = useState(Math.min(2, market.maxLeverage));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const buy = side === "buy";
  const usd = Number(amount) || 0;
  const exposure = usd * lev;
  const units = market.midPx ? exposure / market.midPx : 0;
  // Hyperliquid liquidates at half the initial margin of the market's max leverage.
  const liqMove = Math.max(0, 1 / lev - 1 / (2 * market.maxLeverage));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setBusy(false);
    }
  };

  const submit = () =>
    run(async () => {
      const fill = await trading.withAgent(async (agent) => {
        await updateLeverage(agent, market, lev);
        return placeMarketOrder(agent, { market, isBuy: buy, size: units, reduceOnly: false, slippage: DEFAULT_SLIPPAGE });
      });
      notify(`${buy ? "Bought" : "Sold"} ${fill.totalSz} ${market.base} at $${fill.avgPx}`, "ok");
      onTraded();
      onClose();
    });

  let cta: { label: string; onClick?: () => void; disabled?: boolean };
  if (!user) cta = { label: "Connect wallet", onClick: () => run(connect) };
  else if (trading.checking) cta = { label: "Checking your account…", disabled: true };
  else if (!trading.ready) cta = { label: "Set up trading", onClick: () => run(trading.enable) };
  else if (usd <= 0) cta = { label: "Enter an amount", disabled: true };
  else if (usd > available) cta = { label: available > 0 ? `You have ${fmtUsd(available)} available` : "Add funds to trade", disabled: true };
  else cta = { label: `${buy ? "Buy" : "Sell"} ${fmtUsd(exposure, 0)} of ${market.base}`, onClick: submit };

  return (
    <div className="scrim" onClick={onClose}>
      <div className={`sheet trade ${side}`} role="dialog" aria-label={`${buy ? "Buy" : "Sell"} ${market.base}`} onClick={(e) => e.stopPropagation()}>
        <header className="trade-head">
          <h2>
            {buy ? "Buy" : "Sell"} {market.base}
          </h2>
          <p>Profit if {market.base} goes {buy ? "up" : "down"}.</p>
        </header>

        <label className="amount">
          <span className="sr-only">Amount in US dollars</span>
          <span className="cur">$</span>
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        </label>
        <div className="chips">
          {AMOUNTS.map((a) => (
            <button key={a} className={`chip ${usd === a ? "on" : ""}`} onClick={() => setAmount(String(a))}>
              ${a}
            </button>
          ))}
          {user && available > 0 && (
            <button className="chip" onClick={() => setAmount(String(Math.floor(available * 100) / 100))}>
              Max
            </button>
          )}
        </div>

        <div className="lev">
          <span className="lev-label">Leverage</span>
          <div className="chips">
            {levs.map((l) => (
              <button key={l} className={`chip ${lev === l ? "on" : ""}`} onClick={() => setLev(l)}>
                {l}x
              </button>
            ))}
          </div>
        </div>

        {usd > 0 && (
          <p className="explain">
            You control <strong>{fmtUsd(exposure, 0)}</strong> of {market.base} with {fmtUsd(usd, 0)}. If it moves about{" "}
            <strong>{Math.round(liqMove * 100)}%</strong> {buy ? "down" : "up"}, you lose the {fmtUsd(usd, 0)}.
          </p>
        )}

        <button className="cta" onClick={cta.onClick} disabled={busy || cta.disabled}>
          {busy ? "Confirm in your wallet…" : cta.label}
        </button>

        {user && !trading.ready && !trading.checking && (
          <p className="fine">
            One-time, two signatures: approve the {feeToPercent(BUILDER_FEE)} app fee and a trading key kept in this
            browser. The key can place trades but can never withdraw.
          </p>
        )}
        {user && trading.ready && available <= 0 && (
          <p className="fine">
            Deposit USDC on{" "}
            <a href={HL_APP_URL} target="_blank" rel="noreferrer">
              Hyperliquid
            </a>{" "}
            and make it available for {market.dex} markets, then come back.
          </p>
        )}
        <p className="fine">
          {BUILDER_ADDRESS ? `App fee ${feeToPercent(BUILDER_FEE)} plus Hyperliquid's trading fee. ` : ""}
          Trades execute on Hyperliquid. Not available to US persons.
        </p>
      </div>
    </div>
  );
}
