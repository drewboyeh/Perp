import { useEffect, useState } from "react";
import { APP_NAME, BUILDER_ADDRESS, NETWORK } from "./config";
import { useAccount, useMarkets, useWallet } from "./hooks";
import { MarketHeader } from "./components/MarketHeader";
import { MarketList } from "./components/MarketList";
import { OrderPanel } from "./components/OrderPanel";
import { Positions } from "./components/Positions";

type Toast = { msg: string; kind: "ok" | "err" };

export function App() {
  const { account: user, provider, connect } = useWallet();
  const markets = useMarkets();
  const account = useAccount(user);
  const [selected, setSelected] = useState<string>();
  const [toast, setToast] = useState<Toast>();

  const list = markets.data?.markets ?? [];
  const market = list.find((m) => m.coin === selected) ?? list[0];
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  const notify = (msg: string, kind: "ok" | "err" = "ok") => setToast({ msg, kind });

  return (
    <div className="app">
      <header className="header">
        <div className="brand">{APP_NAME}</div>
        <div className="header-right">
          {NETWORK === "testnet" && <span className="pill">Testnet</span>}
          {user ? (
            <span className="pill mono">
              {user.slice(0, 6)}…{user.slice(-4)}
            </span>
          ) : (
            <button className="btn primary" onClick={() => connect().catch((e) => notify(e.message, "err"))}>
              Connect wallet
            </button>
          )}
        </div>
      </header>

      {!BUILDER_ADDRESS && (
        <div className="banner">Set VITE_BUILDER_ADDRESS to earn fees on trades placed through this app.</div>
      )}
      {markets.data?.missing.length ? (
        <div className="banner">Not found on Hyperliquid: {markets.data.missing.join(", ")} (check VITE_DEXS).</div>
      ) : null}

      <main className="trade">
        <MarketList markets={list} selected={market?.coin} onSelect={setSelected} />
        <div className="center">
          {market ? (
            <MarketHeader market={market} />
          ) : (
            <section className="panel empty muted">
              {markets.error ? `Couldn't load markets: ${markets.error}` : "Loading markets…"}
            </section>
          )}
          <Positions
            user={user}
            account={account.data}
            markets={list}
            onSelect={setSelected}
            notify={notify}
            onTraded={account.refresh}
          />
        </div>
        {market && (
          <OrderPanel
            market={market}
            user={user}
            provider={provider}
            state={account.data?.byDex[market.dex]}
            connect={connect}
            notify={notify}
            onTraded={account.refresh}
          />
        )}
      </main>

      {toast && (
        <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(undefined)}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
