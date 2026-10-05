import type { Wallet } from "../hooks/useWallet";
import type { ExchangeData } from "../hooks/useExchangeData";
import { CHAIN_NAME } from "../config";
import { fmtUsd, shortAddr } from "../lib/format";

export type View = "trade" | "earn";

interface Props {
  wallet: Wallet;
  data: ExchangeData;
  view: View;
  setView: (v: View) => void;
  onOpenAccount: () => void;
}

export function Header({ wallet, data, view, setView, onOpenAccount }: Props) {
  return (
    <header className="header">
      <div className="brand">
        <span className="logo" aria-hidden>
          ◢◤
        </span>
        <span>Perp Stocks</span>
      </div>
      <nav className="nav">
        <button className={view === "trade" ? "active" : ""} onClick={() => setView("trade")}>
          Trade
        </button>
        <button className={view === "earn" ? "active" : ""} onClick={() => setView("earn")}>
          Earn
        </button>
      </nav>
      <div className="header-right">
        <span className="chip muted">{CHAIN_NAME}</span>
        {wallet.account && data.account && (
          <button className="chip balance" onClick={onOpenAccount} title="Deposit / withdraw">
            <span className="muted">Account</span> {fmtUsd(data.account.balance)}
          </button>
        )}
        {wallet.account ? (
          wallet.wrongChain ? (
            <button className="btn warn" onClick={wallet.switchChain}>
              Switch network
            </button>
          ) : (
            <button className="btn ghost" onClick={onOpenAccount}>
              {shortAddr(wallet.account)}
            </button>
          )
        ) : (
          <button className="btn primary" onClick={wallet.connect}>
            Connect wallet
          </button>
        )}
      </div>
    </header>
  );
}
