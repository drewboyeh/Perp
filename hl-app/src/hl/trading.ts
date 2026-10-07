// Trading on Hyperliquid through this app:
//  1. The user approves this app's builder fee once (user-signed, in their wallet).
//  2. The user approves a local "agent" key once (user-signed). The key lives in this browser and
//     signs orders without wallet pop-ups; it can trade but never withdraw.
//  3. Orders are IOC limit orders at mid ± slippage, carrying the builder code.
import { Wallet } from "ethers";
import { APP_NAME, BUILDER_ADDRESS, BUILDER_FEE, IS_MAINNET, NETWORK } from "../config";
import { exchange, maxBuilderFee } from "./api";
import { feeToPercent, formatSize, slippagePrice } from "./format";
import type { Market } from "./markets";
import { APPROVE_AGENT_TYPES, APPROVE_BUILDER_FEE_TYPES, signL1Action, signUserAction, type Eip1193 } from "./signing";

const HL_CHAIN = IS_MAINNET ? "Mainnet" : "Testnet";
const AGENT_NAME = APP_NAME.replace(/[^A-Za-z0-9 ]/g, "").slice(0, 16) || "web";

let lastNonce = 0;
/** Millisecond timestamp, strictly increasing within this page. */
export function nextNonce() {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
}

const agentKey = (user: string) => `hl-agent:${NETWORK}:${user.toLowerCase()}`;

export function loadAgent(user: string): Wallet | null {
  try {
    const pk = localStorage.getItem(agentKey(user));
    return pk ? new Wallet(pk) : null;
  } catch {
    return null;
  }
}

export function forgetAgent(user: string) {
  try {
    localStorage.removeItem(agentKey(user));
  } catch {}
}

async function walletChainId(provider: Eip1193) {
  return (await provider.request({ method: "eth_chainId" })) as string;
}

export async function builderFeeApproved(user: string) {
  if (!BUILDER_ADDRESS) return true;
  return (await maxBuilderFee(user, BUILDER_ADDRESS)) >= BUILDER_FEE;
}

export async function approveBuilderFee(provider: Eip1193, user: string) {
  const action = {
    type: "approveBuilderFee",
    signatureChainId: await walletChainId(provider),
    hyperliquidChain: HL_CHAIN,
    maxFeeRate: feeToPercent(BUILDER_FEE),
    builder: BUILDER_ADDRESS,
    nonce: nextNonce(),
  };
  const sig = await signUserAction(provider, user, "HyperliquidTransaction:ApproveBuilderFee", APPROVE_BUILDER_FEE_TYPES, action);
  await exchange(action, action.nonce, sig);
}

/** Creates a fresh agent key, has the user approve it, and stores it in this browser. */
export async function approveAgent(provider: Eip1193, user: string): Promise<Wallet> {
  const agent = Wallet.createRandom();
  const action = {
    type: "approveAgent",
    signatureChainId: await walletChainId(provider),
    hyperliquidChain: HL_CHAIN,
    agentAddress: agent.address,
    agentName: AGENT_NAME,
    nonce: nextNonce(),
  };
  const sig = await signUserAction(provider, user, "HyperliquidTransaction:ApproveAgent", APPROVE_AGENT_TYPES, action);
  await exchange(action, action.nonce, sig);
  localStorage.setItem(agentKey(user), agent.privateKey);
  return new Wallet(agent.privateKey);
}

async function sendL1(agent: Wallet, action: unknown) {
  const nonce = nextNonce();
  const sig = await signL1Action(agent, action, nonce, IS_MAINNET);
  return exchange(action, nonce, sig);
}

export function updateLeverage(agent: Wallet, market: Market, leverage: number) {
  return sendL1(agent, {
    type: "updateLeverage",
    asset: market.asset,
    isCross: !market.onlyIsolated,
    leverage: Math.floor(leverage),
  });
}

export interface MarketOrder {
  market: Market;
  isBuy: boolean;
  size: number; // units of the underlying
  reduceOnly: boolean;
  slippage: number;
}

/** Builds the order action exactly as the SDK does (key order matters for the signature hash). */
export function marketOrderAction({ market, isBuy, size, reduceOnly, slippage }: MarketOrder) {
  const s = formatSize(size, market.szDecimals);
  if (Number(s) <= 0) throw new Error("Size is below this market's minimum increment");
  const action: Record<string, unknown> = {
    type: "order",
    orders: [
      {
        a: market.asset,
        b: isBuy,
        p: slippagePrice(market.midPx, isBuy, slippage, market.szDecimals),
        s,
        r: reduceOnly,
        t: { limit: { tif: "Ioc" } },
      },
    ],
    grouping: "na",
  };
  if (BUILDER_ADDRESS) action.builder = { b: BUILDER_ADDRESS, f: BUILDER_FEE };
  return action;
}

export async function placeMarketOrder(agent: Wallet, order: MarketOrder) {
  const res = await sendL1(agent, marketOrderAction(order));
  const status = typeof res.response === "string" ? undefined : res.response.data?.statuses?.[0];
  if (status && "filled" in status) return status.filled;
  throw new Error("Order did not fill (no liquidity within your slippage). Nothing was charged.");
}
