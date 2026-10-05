import { useState } from "react";
import type { ExchangeData } from "../hooks/useExchangeData";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import { deployment } from "../config";
import { fmtUsd, parseWad, shortAddr } from "../lib/format";
import { deposit, faucet, withdraw } from "../lib/actions";
import { Modal } from "./Modal";

interface Props {
  data: ExchangeData;
  wallet: Wallet;
  tx: Tx;
  onClose: () => void;
}

export function AccountModal({ data, wallet, tx, onClose }: Props) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const dec = data.tokenDecimals;
  const scale = 10n ** BigInt(18 - dec);
  const tokens = parseWad(amount, dec);
  const wallet$ = (data.account?.walletBalance ?? 0n) * scale;
  const account$ = data.account?.balance ?? 0n;
  const max = mode === "deposit" ? wallet$ : account$;

  const submit = () =>
    tx
      .run(`${mode === "deposit" ? "Deposit" : "Withdraw"} ${fmtUsd(tokens * scale)}`, async () => {
        const s = await wallet.getSigner();
        await (mode === "deposit" ? deposit(s, tokens) : withdraw(s, tokens));
      })
      .then((ok) => ok && setAmount(""));

  return (
    <Modal title="Trading account" onClose={onClose}>
      {wallet.account && <p className="muted small">Connected as {shortAddr(wallet.account)}</p>}
      <div className="balances">
        <div>
          <span className="muted">Wallet</span>
          <strong className="mono">{fmtUsd(wallet$)}</strong>
        </div>
        <div>
          <span className="muted">Trading account</span>
          <strong className="mono">{fmtUsd(account$)}</strong>
        </div>
      </div>
      <div className="tabs">
        <button className={mode === "deposit" ? "active" : ""} onClick={() => setMode("deposit")}>
          Deposit
        </button>
        <button className={mode === "withdraw" ? "active" : ""} onClick={() => setMode("withdraw")}>
          Withdraw
        </button>
      </div>
      <label className="field">
        <span className="field-label">
          Amount (USDC)
          <button className="link" onClick={() => setAmount((Number(max / scale) / 10 ** dec).toString())}>
            Max
          </button>
        </span>
        <input className="input mono" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
      </label>
      <button
        className="btn block primary"
        disabled={tokens === 0n || tokens * scale > max || tx.busy}
        onClick={submit}
      >
        {mode === "deposit" ? "Deposit" : "Withdraw"}
      </button>
      {deployment?.oracleType === "mock" && (
        <button
          className="btn block ghost"
          disabled={tx.busy}
          onClick={() => tx.run("Mint 10,000 test USDC", async () => faucet(await wallet.getSigner()))}
        >
          Get 10,000 test USDC
        </button>
      )}
    </Modal>
  );
}
