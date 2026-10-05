import type { Signer } from "ethers";
import type { Wallet } from "../hooks/useWallet";
import type { Tx } from "../hooks/useTx";
import type { ExchangeData, Market } from "../hooks/useExchangeData";
import { commitOrder, deposit, waitForOrder } from "./actions";
import { fmtPrice } from "./format";

interface OrderRequest {
  label: string;
  market: Market;
  sizeDelta: bigint;
  marginDelta: bigint;
  acceptablePrice: bigint;
  reduceOnly?: boolean;
  /** Account balance (USD WAD) the commit must escrow: positive margin + keeper fee. */
  escrow: bigint;
}

/**
 * Commits an order (topping up the trading account from the wallet if needed), then tracks it
 * in a background toast until a keeper executes it, it's rejected, or it expires.
 */
export async function submitOrder(wallet: Wallet, tx: Tx, data: ExchangeData, req: OrderRequest) {
  let block = 0;
  let trader = "";
  const scale = 10n ** BigInt(18 - data.tokenDecimals);
  const ok = await tx.run(`Submit ${req.label}`, async () => {
    const s: Signer = await wallet.getSigner();
    trader = await s.getAddress();
    const balance = data.account?.balance ?? 0n;
    if (req.escrow > balance) await deposit(s, (req.escrow - balance + scale - 1n) / scale);
    block = await commitOrder(s, req.market.id, req.sizeDelta, req.marginDelta, req.acceptablePrice, req.reduceOnly);
  });
  if (!ok) return;

  const timeoutMs = ((data.orderConfig?.maxDelay ?? 120) + 15) * 1000;
  void tx.track(`${req.label}: waiting for execution at the next oracle price…`, async () => {
    const o = await waitForOrder(wallet.readProvider, req.market.id, trader, block, timeoutMs);
    switch (o.status) {
      case "filled":
        return { kind: "success", text: o.fillPrice ? `${req.label} filled at $${fmtPrice(o.fillPrice)}` : `${req.label} executed` };
      case "rejected":
        return { kind: "error", text: `${req.label} not filled: ${o.reason}. Escrow refunded.` };
      case "expired":
        return { kind: "info", text: `${req.label} expired unexecuted. Escrow refunded.` };
      default:
        return { kind: "info", text: `${req.label} is still pending. You can execute it yourself under Orders.` };
    }
  });
}
