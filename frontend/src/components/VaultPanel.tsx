import { useState } from "react";
import type { ExchangeData } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { WAD, fmtPct, fmtUsd, parseWad, toNum } from "../lib/format";
import { addLiquidity, removeLiquidity } from "../lib/actions";

interface Props {
  data: ExchangeData;
  wallet: Wallet;
  tx: Tx;
}

export function VaultPanel({ data, wallet, tx }: Props) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const v = data.vault;
  const acct = data.account;
  const dec = data.tokenDecimals;
  const scale = 10n ** BigInt(18 - dec);

  const nav = v?.nav ?? 0n;
  const totalShares = v?.totalShares ?? 0n;
  const myShares = acct?.lpShares ?? 0n;
  const myValue = totalShares > 0n && nav > 0n ? (myShares * nav) / totalShares : 0n;
  const utilization = v && v.balance > 0n ? (v.totalSkewNotional * WAD) / v.balance : 0n;
  const traderPnl = v ? v.balance - nav : 0n;
  const unlock = acct?.lpUnlockTime ?? 0;
  const locked = unlock * 1000 > Date.now();
  // Markets with open interest need fresh prices to value the vault.
  const feedsWithOi = data.markets.filter((m) => m.longOpenInterest + m.shortOpenInterest > 0n).map((m) => m.feedId);

  const value = parseWad(amount);
  const tokens = parseWad(amount, dec);
  const sharesToBurn = mode === "withdraw" && myValue > 0n ? (value >= myValue ? myShares : (myShares * value) / myValue) : 0n;
  const max = mode === "deposit" ? (acct?.walletBalance ?? 0n) * scale : myValue;

  const submit = () =>
    tx
      .run(`${mode === "deposit" ? "Provide" : "Withdraw"} ${fmtUsd(value)} liquidity`, async () => {
        const s = await wallet.getSigner();
        if (mode === "deposit") await addLiquidity(s, tokens, feedsWithOi);
        else await removeLiquidity(s, sharesToBurn, feedsWithOi);
      })
      .then((ok) => ok && setAmount(""));

  return (
    <div className="earn">
      <section className="panel earn-hero">
        <h1>Liquidity Vault</h1>
        <p className="muted">
          The vault is the counterparty to every trader. LPs earn all trading fees, the listing fees, funding paid by the
          crowded side and trader losses — and pay out trader profits. Open interest is capped by vault size.
        </p>
        <div className="kpis">
          <div className="kpi">
            <span>Net asset value</span>
            <strong className="mono">{fmtUsd(nav)}</strong>
          </div>
          <div className="kpi">
            <span>Vault cash</span>
            <strong className="mono">{fmtUsd(v?.balance ?? 0n)}</strong>
          </div>
          <div className="kpi">
            <span>Traders' open PnL</span>
            <strong className={`mono ${traderPnl > 0n ? "down" : "up"}`}>{fmtUsd(traderPnl)}</strong>
          </div>
          <div className="kpi">
            <span>Utilization</span>
            <strong className="mono">{fmtPct(utilization, 1)}</strong>
            <div className="bar">
              <div style={{ width: `${Math.min(100, toNum(utilization) * 100)}%` }} />
            </div>
          </div>
        </div>
      </section>

      <section className="panel earn-form">
        <div className="balances">
          <div>
            <span className="muted">Your liquidity</span>
            <strong className="mono">{fmtUsd(myValue)}</strong>
          </div>
          <div>
            <span className="muted">Share of vault</span>
            <strong className="mono">{totalShares ? fmtPct((myShares * WAD) / totalShares, 3) : "0%"}</strong>
          </div>
        </div>
        {locked && <p className="note">Locked until {new Date(unlock * 1000).toLocaleString()} (deposit lockup).</p>}
        <div className="tabs">
          <button className={mode === "deposit" ? "active" : ""} onClick={() => setMode("deposit")}>
            Provide
          </button>
          <button className={mode === "withdraw" ? "active" : ""} onClick={() => setMode("withdraw")}>
            Withdraw
          </button>
        </div>
        <label className="field">
          <span className="field-label">
            Amount (USD)
            <button className="link" onClick={() => setAmount(toNum(max).toFixed(2))}>
              Max {fmtUsd(max)}
            </button>
          </span>
          <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </label>
        <button
          className="btn block primary"
          disabled={!wallet.account || value === 0n || value > max || tx.busy || (mode === "withdraw" && locked)}
          onClick={submit}
        >
          {!wallet.account ? "Connect wallet" : mode === "deposit" ? "Provide liquidity" : "Withdraw liquidity"}
        </button>
      </section>
    </div>
  );
}
