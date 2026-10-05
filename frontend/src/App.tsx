import { useEffect, useState } from "react";
import { CHAIN_ID, deployment } from "./config";
import { useWallet } from "./hooks/useWallet";
import { useExchangeData } from "./hooks/useExchangeData";
import { useTx } from "./hooks/useTx";
import { Header, type View } from "./components/Header";
import { MarketList } from "./components/MarketList";
import { MarketHeader } from "./components/MarketHeader";
import { PriceChart } from "./components/PriceChart";
import { OrderPanel } from "./components/OrderPanel";
import { Positions } from "./components/Positions";
import { VaultPanel } from "./components/VaultPanel";
import { AccountModal } from "./components/AccountModal";
import { ListMarketModal } from "./components/ListMarketModal";
import { Toasts } from "./components/Toasts";
import { toNum } from "./lib/format";

export default function App() {
  const wallet = useWallet();
  const data = useExchangeData(wallet.readProvider, wallet.account);
  const tx = useTx(data.refresh);
  const [view, setView] = useState<View>("trade");
  const [selected, setSelected] = useState<number>();
  const [accountOpen, setAccountOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [pendingSymbol, setPendingSymbol] = useState<string>();

  useEffect(() => {
    if (selected === undefined && data.markets.length) setSelected(data.markets[0].id);
    if (pendingSymbol) {
      const m = data.markets.find((x) => x.symbol === pendingSymbol);
      if (m) {
        setSelected(m.id);
        setPendingSymbol(undefined);
      }
    }
  }, [data.markets, selected, pendingSymbol]);

  if (!deployment) {
    return (
      <div className="setup">
        <h1>No deployment for chain {CHAIN_ID}</h1>
        <p>
          Deploy the contracts first: <code>npm run node</code> then <code>npm run deploy:local</code> from the repo
          root. The deploy script writes <code>frontend/src/config/deployments.json</code>.
        </p>
      </div>
    );
  }

  const market = data.markets.find((m) => m.id === selected);
  const position = market && data.account?.positions.find((p) => p.marketId === market.id);

  return (
    <div className="app">
      <Header
        wallet={wallet}
        data={data}
        view={view}
        setView={setView}
        onOpenAccount={() => (wallet.account ? setAccountOpen(true) : wallet.connect())}
      />
      {data.error && <div className="banner">Can't reach the chain RPC: {data.error.slice(0, 120)}</div>}

      {view === "trade" ? (
        <main className="trade">
          <MarketList
            markets={data.markets}
            selected={selected}
            onSelect={setSelected}
            onList={() => setListOpen(true)}
            history={data.history}
          />
          <section className="center">
            {market ? (
              <>
                <MarketHeader market={market} />
                <PriceChart
                  points={data.history[market.id] ?? []}
                  entry={position ? toNum(position.entryPrice) : undefined}
                  liquidation={position ? toNum(position.liquidationPrice) : undefined}
                />
              </>
            ) : (
              <div className="panel empty">{data.markets.length ? "Select a market" : "Loading markets…"}</div>
            )}
            <Positions data={data} wallet={wallet} tx={tx} onSelect={setSelected} />
          </section>
          {market && <OrderPanel market={market} data={data} wallet={wallet} tx={tx} />}
        </main>
      ) : (
        <main>
          <VaultPanel data={data} wallet={wallet} tx={tx} />
        </main>
      )}

      {accountOpen && <AccountModal data={data} wallet={wallet} tx={tx} onClose={() => setAccountOpen(false)} />}
      {listOpen && (
        <ListMarketModal
          data={data}
          wallet={wallet}
          tx={tx}
          onClose={() => setListOpen(false)}
          onListed={setPendingSymbol}
        />
      )}
      <Toasts toasts={tx.toasts} dismiss={tx.dismiss} />
    </div>
  );
}
