import { useState } from "react";
import type { ExchangeData } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { deployment } from "../config";
import { errorMessage, fmtUsd, parseWad } from "../lib/format";
import { createMarket, deposit, mockFeedId } from "../lib/actions";
import { searchPythEquities, type PythFeed } from "../lib/oracle";
import { Modal } from "./Modal";

interface Props {
  data: ExchangeData;
  wallet: Wallet;
  tx: Tx;
  onClose: () => void;
  onListed: (symbol: string) => void;
}

export function ListMarketModal({ data, wallet, tx, onClose, onListed }: Props) {
  const isPyth = deployment?.oracleType === "pyth";
  const [ticker, setTicker] = useState("");
  const [initialPrice, setInitialPrice] = useState("");
  const [results, setResults] = useState<PythFeed[]>();
  const [picked, setPicked] = useState<PythFeed>();
  const [searchErr, setSearchErr] = useState<string>();

  const fee = data.risk?.listingFee ?? 0n;
  const symbol = (picked ? picked.symbol.split(".").pop()!.replace("/USD", "") : ticker).toUpperCase();
  const listed = new Set(data.markets.map((m) => m.feedId.toLowerCase()));
  const feedId = isPyth ? picked?.id : ticker ? mockFeedId(ticker) : undefined;
  const already = feedId ? listed.has(feedId.toLowerCase()) : false;
  const scale = 10n ** BigInt(18 - data.tokenDecimals);

  const search = async () => {
    setSearchErr(undefined);
    setPicked(undefined);
    try {
      setResults(await searchPythEquities(ticker));
    } catch (e) {
      setSearchErr(errorMessage(e));
    }
  };

  const submit = () =>
    tx
      .run(`List ${symbol}`, async () => {
        const s = await wallet.getSigner();
        const bal = data.account?.balance ?? 0n;
        if (bal < fee) await deposit(s, (fee - bal + scale - 1n) / scale);
        await createMarket(s, symbol, feedId!, isPyth ? undefined : parseWad(initialPrice));
      })
      .then((ok) => {
        if (ok) {
          onListed(symbol);
          onClose();
        }
      });

  const valid = !!feedId && !already && /^[A-Z0-9.]{1,16}$/.test(symbol) && (isPyth || parseWad(initialPrice) > 0n);

  return (
    <Modal title="List a stock" onClose={onClose}>
      <p className="muted small">
        Anyone can open a perpetual market on any stock with an oracle feed. The {fmtUsd(fee, 0)} listing fee goes to
        liquidity providers. New markets use the default risk parameters.
      </p>
      <label className="field">
        <span className="field-label">Ticker</span>
        <div className="row">
          <input
            className="input mono"
            placeholder="e.g. COIN"
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase().trim())}
            onKeyDown={(e) => e.key === "Enter" && isPyth && search()}
          />
          {isPyth && (
            <button className="btn" onClick={search} disabled={!ticker}>
              Search
            </button>
          )}
        </div>
      </label>

      {isPyth ? (
        <>
          {searchErr && <p className="error">{searchErr}</p>}
          {results && (
            <ul className="feed-results">
              {results.length === 0 && <li className="muted">No equity feeds found.</li>}
              {results.slice(0, 8).map((f) => (
                <li key={f.id}>
                  <button className={picked?.id === f.id ? "selected" : ""} onClick={() => setPicked(f)}>
                    <strong>{f.symbol}</strong>
                    <span className="muted small">{f.description}</span>
                    {listed.has(f.id.toLowerCase()) && <span className="tag">listed</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <label className="field">
          <span className="field-label">Initial price (USD)</span>
          <input
            className="input mono"
            inputMode="decimal"
            placeholder="Seeds the dev oracle"
            value={initialPrice}
            onChange={(e) => setInitialPrice(e.target.value)}
          />
          <span className="field-hint">Dev mode: the mock oracle needs a starting price; the feeder moves it after.</span>
        </label>
      )}

      {already && <p className="error">That feed is already listed.</p>}
      <button className="btn block primary" disabled={!valid || tx.busy || !wallet.account} onClick={submit}>
        {wallet.account ? `List ${symbol || "market"} · ${fmtUsd(fee, 0)}` : "Connect wallet"}
      </button>
    </Modal>
  );
}
