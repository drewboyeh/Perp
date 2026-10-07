import { useEffect, useRef, useState } from "react";
import { APP_NAME, BUILDER_ADDRESS, NETWORK } from "./config";
import { useAccount, useMarkets, useTrading, useWallet } from "./hooks";
import type { Interval } from "./hl/api";
import { fmtPct, fmtPx, fmtUsd } from "./hl/format";
import { Chart, type ChartStyle } from "./components/Chart";
import { TickerSheet } from "./components/TickerSheet";
import { TradeSheet, type Side } from "./components/TradeSheet";
import { PositionsSheet, baseOf, closePosition } from "./components/PositionsSheet";

const INTERVALS: [Interval, string][] = [
  ["5m", "5m"],
  ["1h", "1H"],
  ["1d", "1D"],
  ["1w", "1W"],
];

type Toast = { msg: string; kind: "ok" | "err" };

/** Remembers a small UI preference in this browser; works without storage too. */
function usePref<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      return (localStorage.getItem(key) as T) || initial;
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setV(next);
    try {
      localStorage.setItem(key, next);
    } catch {}
  };
  return [v, set];
}

export function App() {
  const { account: user, provider, connect } = useWallet();
  const markets = useMarkets();
  const account = useAccount(user);
  const trading = useTrading(user, provider);
  const [coin, setCoin] = usePref<string>("coin", "");
  const [interval, setInterval_] = usePref<Interval>("interval", "1h");
  const [style, setStyle] = usePref<ChartStyle>("style", "candles");
  const [sheet, setSheet] = useState<"tickers" | "positions" | Side>();
  const [toast, setToast] = useState<Toast>();
  const [closing, setClosing] = useState(false);

  const list = markets.data?.markets ?? [];
  const market = list.find((m) => m.coin === coin) ?? list[0];
  const notify = (msg: string, kind: "ok" | "err" = "ok") => setToast({ msg, kind });

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(undefined), 6000);
    return () => clearTimeout(id);
  }, [toast]);

  // Flash the price green or red when it ticks.
  const prev = useRef<{ coin?: string; px?: number }>({});
  const [tick, setTick] = useState<"up" | "down">();
  useEffect(() => {
    const { coin: c, px } = { coin: market?.coin, px: market?.markPx };
    const before = prev.current;
    prev.current = { coin: c, px };
    if (!px || !before.px || before.coin !== c || px === before.px) return setTick(undefined);
    setTick(px > before.px ? "up" : "down");
    const id = setTimeout(() => setTick(undefined), 700);
    return () => clearTimeout(id);
  }, [market?.markPx, market?.coin]);

  const states = Object.values(account.data?.byDex ?? {});
  const positions = states.flatMap((s) => s.assetPositions.map((p) => p.position)).filter((p) => Number(p.szi) !== 0);
  const accountValue = states.reduce((sum, s) => sum + Number(s.marginSummary.accountValue), 0);
  const available = market ? Number(account.data?.byDex[market.dex]?.withdrawable ?? 0) : 0;
  const here = market && positions.find((p) => p.coin === market.coin);
  const change = market?.prevDayPx ? market.markPx / market.prevDayPx - 1 : 0;
  const preIpo = market?.category === "preipo";

  const closeHere = async () => {
    if (!market || !here) return;
    setClosing(true);
    try {
      const fill = await closePosition(trading, market, Number(here.szi));
      notify(`Closed ${fill.totalSz} ${market.base} at $${fill.avgPx}`, "ok");
      account.refresh();
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "err");
    } finally {
      setClosing(false);
    }
  };

  return (
    <div className="app">
      <header className="bar">
        <span className="mark" title={APP_NAME}>
          {APP_NAME}
        </span>
        <button className="ticker-btn" onClick={() => setSheet("tickers")} disabled={!list.length}>
          {preIpo && <span className="dot" aria-hidden />}
          {market?.base ?? "Markets"}
          <svg width="10" height="6" viewBox="0 0 10 6" aria-hidden>
            <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <div className="seg" role="group" aria-label="Timeframe">
          {INTERVALS.map(([id, label]) => (
            <button key={id} className={interval === id ? "on" : ""} onClick={() => setInterval_(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Chart style">
          <button className={style === "candles" ? "on" : ""} onClick={() => setStyle("candles")} aria-label="Candles">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M3 1v12M11 2v10" stroke="currentColor" strokeWidth="1.2" />
              <rect x="1.5" y="4" width="3" height="6" fill="currentColor" />
              <rect x="9.5" y="5" width="3" height="4" fill="none" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </button>
          <button className={style === "line" ? "on" : ""} onClick={() => setStyle("line")} aria-label="Line">
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden>
              <path d="M1 11l4-5 3 3 5-7" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <span className="grow" />
        {NETWORK === "testnet" && <span className="badge">Testnet</span>}
        {user ? (
          <button className="acct" onClick={() => setSheet("positions")}>
            <span>{fmtUsd(accountValue)}</span>
            {positions.length > 0 && <span className="acct-count">{positions.length}</span>}
          </button>
        ) : (
          <button className="acct" onClick={() => connect().catch((e) => notify(e.message, "err"))}>
            Connect
          </button>
        )}
      </header>

      <main className="stage">
        {market ? (
          <>
            <div className="quote" aria-live="polite">
              <p className="eyebrow">
                {market.base}
                {preIpo && <span className="pre">Pre-IPO</span>}
              </p>
              <p className={`price ${tick ?? ""}`}>${fmtPx(market.markPx)}</p>
              <p className={`change ${change >= 0 ? "up" : "down"}`}>{fmtPct(change)} today</p>
              {preIpo && <p className="pre-note">Synthetic price for a private company. You never own shares.</p>}
            </div>
            <Chart coin={market.coin} interval={interval} style={style} livePx={market.markPx} />
          </>
        ) : (
          <p className="chart-msg">{markets.error ? `Can't reach Hyperliquid: ${markets.error}` : "Loading markets…"}</p>
        )}

        {market && (
          <div className="dock">
            {here && (
              <div className="holding">
                <span>
                  {Number(here.szi) > 0 ? "Bought" : "Sold"} {Math.abs(Number(here.szi))} {baseOf(here.coin)}
                </span>
                <span className={Number(here.unrealizedPnl) >= 0 ? "up" : "down"}>
                  {Number(here.unrealizedPnl) >= 0 ? "+" : ""}
                  {fmtUsd(Number(here.unrealizedPnl))}
                </span>
                <button onClick={closeHere} disabled={closing}>
                  {closing ? "Closing…" : "Close"}
                </button>
              </div>
            )}
            <div className="actions">
              <button className="act sell" onClick={() => setSheet("sell")}>
                Sell
              </button>
              <button className="act buy" onClick={() => setSheet("buy")}>
                Buy
              </button>
            </div>
          </div>
        )}
      </main>

      {!BUILDER_ADDRESS && <p className="dev-note">Dev: set VITE_BUILDER_ADDRESS to earn fees on trades.</p>}
      {markets.data?.missing.length ? (
        <p className="dev-note">Dev: no dex named {markets.data.missing.join(", ")} on Hyperliquid (check VITE_DEXS).</p>
      ) : null}

      {sheet === "tickers" && (
        <TickerSheet
          markets={list}
          current={market?.coin}
          onPick={(c) => {
            setCoin(c);
            setSheet(undefined);
          }}
          onClose={() => setSheet(undefined)}
        />
      )}
      {(sheet === "buy" || sheet === "sell") && market && (
        <TradeSheet
          side={sheet}
          market={market}
          user={user}
          available={available}
          trading={trading}
          connect={connect}
          notify={notify}
          onClose={() => setSheet(undefined)}
          onTraded={account.refresh}
        />
      )}
      {sheet === "positions" && (
        <PositionsSheet
          positions={positions}
          accountValue={accountValue}
          markets={list}
          trading={trading}
          notify={notify}
          onPick={(c) => {
            setCoin(c);
            setSheet(undefined);
          }}
          onClose={() => setSheet(undefined)}
          onTraded={account.refresh}
        />
      )}
      {toast && (
        <div className={`toast ${toast.kind}`} role="status" onClick={() => setToast(undefined)}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
