import { useEffect, useState } from "react";
import type { Wallet } from "ethers";
import { BUILDER_ADDRESS, BUILDER_FEE, DEFAULT_SLIPPAGE, HL_APP_URL } from "../config";
import type { ClearinghouseState } from "../hl/api";
import { feeToPercent, fmtPx, fmtUsd } from "../hl/format";
import type { Market } from "../hl/markets";
import type { Eip1193 } from "../hl/signing";
import {
  approveAgent,
  approveBuilderFee,
  builderFeeApproved,
  forgetAgent,
  loadAgent,
  placeMarketOrder,
  updateLeverage,
} from "../hl/trading";

interface Props {
  market: Market;
  user?: string;
  provider?: Eip1193;
  state?: ClearinghouseState;
  connect: () => Promise<void>;
  notify: (msg: string, kind?: "ok" | "err") => void;
  onTraded: () => void;
}

export function OrderPanel({ market, user, provider, state, connect, notify, onTraded }: Props) {
  const [side, setSide] = useState<"long" | "short">("long");
  const [margin, setMargin] = useState("100");
  const [leverage, setLeverage] = useState(Math.min(3, market.maxLeverage));
  const [agent, setAgent] = useState<Wallet | null>(null);
  const [feeOk, setFeeOk] = useState<boolean>();
  const [busy, setBusy] = useState(false);

  useEffect(() => setLeverage((l) => Math.min(l, market.maxLeverage)), [market.maxLeverage]);
  useEffect(() => {
    setAgent(user ? loadAgent(user) : null);
    setFeeOk(undefined);
    if (user) builderFeeApproved(user).then(setFeeOk, () => setFeeOk(false));
  }, [user]);

  const marginUsd = Number(margin) || 0;
  const notional = marginUsd * leverage;
  const size = market.midPx ? notional / market.midPx : 0;
  const available = state ? Number(state.withdrawable) : 0;
  const ready = !!agent && feeOk === true;
  const appFee = BUILDER_ADDRESS ? (notional * BUILDER_FEE) / 100_000 : 0;

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      notify(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, "err");
    } finally {
      setBusy(false);
    }
  };

  const enable = () =>
    run("Enable trading", async () => {
      if (!user || !provider) return;
      if (!feeOk) {
        await approveBuilderFee(provider, user);
        setFeeOk(true);
      }
      if (!agent) setAgent(await approveAgent(provider, user));
      notify("Trading enabled for this browser", "ok");
    });

  const submit = () =>
    run("Order", async () => {
      if (!agent || !user) return;
      let fill;
      try {
        await updateLeverage(agent, market, leverage);
        fill = await placeMarketOrder(agent, {
          market,
          isBuy: side === "long",
          size,
          reduceOnly: false,
          slippage: DEFAULT_SLIPPAGE,
        });
      } catch (e) {
        // Hyperliquid rejects keys that were revoked, expired or never approved for this account.
        if (/does not exist/i.test(e instanceof Error ? e.message : String(e))) {
          forgetAgent(user);
          setAgent(null);
          throw new Error("this browser's trading key is no longer approved. Click Enable trading to set it up again.");
        }
        throw e;
      }
      notify(`${side === "long" ? "Long" : "Short"} ${fill.totalSz} ${market.base} filled at $${fill.avgPx}`, "ok");
      onTraded();
    });

  let action: { label: string; onClick?: () => void; disabled?: boolean };
  if (!user) action = { label: "Connect wallet", onClick: () => void connect().catch((e) => notify(e.message, "err")) };
  else if (feeOk === undefined) action = { label: "Checking account…", disabled: true };
  else if (!ready) action = { label: "Enable trading", onClick: enable };
  else if (marginUsd <= 0) action = { label: "Enter an amount", disabled: true };
  else if (marginUsd > available) action = { label: "Not enough available margin", disabled: true };
  else action = { label: `${side === "long" ? "Long" : "Short"} ${market.base} ${leverage}x`, onClick: submit };

  return (
    <aside className="panel order">
      <div className="sides">
        <button className={`side long ${side === "long" ? "active" : ""}`} onClick={() => setSide("long")}>
          Long
        </button>
        <button className={`side short ${side === "short" ? "active" : ""}`} onClick={() => setSide("short")}>
          Short
        </button>
      </div>

      <label className="field">
        <span className="field-label">
          Margin <span className="muted">USDC</span>
        </span>
        <input className="input mono" inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
      </label>
      {user && (
        <p className="muted small">
          Available on {market.dex}: {fmtUsd(available)}
        </p>
      )}

      <label className="field">
        <span className="field-label">
          Leverage <span className="mono">{leverage}x</span>
        </span>
        <input
          type="range"
          min={1}
          max={market.maxLeverage}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
        />
      </label>

      <dl className="summary">
        <div>
          <dt>Position size</dt>
          <dd className="mono">
            {size ? size.toFixed(market.szDecimals) : "0"} {market.base}
          </dd>
        </div>
        <div>
          <dt>Notional</dt>
          <dd className="mono">{fmtUsd(notional)}</dd>
        </div>
        <div>
          <dt>Price</dt>
          <dd className="mono">≈ ${fmtPx(market.midPx)}</dd>
        </div>
        {BUILDER_ADDRESS && (
          <div>
            <dt>App fee ({feeToPercent(BUILDER_FEE)})</dt>
            <dd className="mono">{fmtUsd(appFee, 4)}</dd>
          </div>
        )}
        <div>
          <dt>Max slippage</dt>
          <dd className="mono">{DEFAULT_SLIPPAGE * 100}%</dd>
        </div>
      </dl>

      <button className={`btn primary ${side}`} onClick={action.onClick} disabled={busy || action.disabled}>
        {busy ? "Waiting…" : action.label}
      </button>

      {user && !ready && feeOk !== undefined && (
        <p className="note">
          One-time setup, two signatures: approve this app's {feeToPercent(BUILDER_FEE)} fee, then approve a trading key
          stored in this browser. The key can place orders for you but can never withdraw funds.
        </p>
      )}
      {user && ready && available === 0 && (
        <p className="note">
          No margin on {market.dex} yet. Deposit USDC on{" "}
          <a href={HL_APP_URL} target="_blank" rel="noreferrer">
            Hyperliquid
          </a>{" "}
          and make it available to {market.dex} markets, then come back.
        </p>
      )}
      <p className="disclaimer muted small">
        Orders execute on Hyperliquid. Leveraged trading can lose your entire margin. Not available to US persons.
      </p>
    </aside>
  );
}
