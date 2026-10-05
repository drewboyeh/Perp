import { Contract, MaxUint256, id as keccakId, type Provider, type Signer } from "ethers";
import { deployment, ERC20_ABI, EXCHANGE_ABI, MOCK_ORACLE_ABI } from "../config";
import { getPriceUpdate } from "./oracle";

const exchangeFor = (s: Signer | Provider) => new Contract(deployment!.exchange, EXCHANGE_ABI, s);
const tokenFor = (s: Signer) => new Contract(deployment!.collateral, ERC20_ABI, s);

async function withUpdate(s: Signer, feedIds: string[]) {
  const update = await getPriceUpdate(feedIds);
  const fee: bigint = update.length ? await exchangeFor(s).getOracleUpdateFee(update) : 0n;
  return { update, value: fee };
}

async function ensureAllowance(s: Signer, amount: bigint) {
  const owner = await s.getAddress();
  const token = tokenFor(s);
  const allowance: bigint = await token.allowance(owner, deployment!.exchange);
  if (allowance < amount) await (await token.approve(deployment!.exchange, MaxUint256)).wait();
}

export async function faucet(s: Signer) {
  await (await tokenFor(s).faucet()).wait();
}

export async function deposit(s: Signer, tokenAmount: bigint) {
  await ensureAllowance(s, tokenAmount);
  await (await exchangeFor(s).deposit(tokenAmount)).wait();
}

export async function withdraw(s: Signer, tokenAmount: bigint) {
  await (await exchangeFor(s).withdraw(tokenAmount)).wait();
}

/**
 * Step 1 of a trade: commit an order. A keeper executes it after the order delay at a price
 * published after the commit. Returns the commit block so callers can watch for the outcome.
 */
export async function commitOrder(
  s: Signer,
  marketId: number,
  sizeDelta: bigint,
  marginDelta: bigint,
  acceptablePrice: bigint,
  reduceOnly = false,
): Promise<number> {
  const rc = await (await exchangeFor(s).commitOrder(marketId, sizeDelta, marginDelta, acceptablePrice, reduceOnly)).wait();
  return rc.blockNumber as number;
}

/** Step 2: execute a pending order (anyone can; the caller earns the keeper fee). */
export async function executeOrder(s: Signer, marketId: number, feedId: string, trader: string) {
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).executeOrder(marketId, trader, update, { value })).wait();
}

export async function cancelOrder(s: Signer, marketId: number, trader: string) {
  await (await exchangeFor(s).cancelOrder(marketId, trader)).wait();
}

export type OrderOutcome =
  | { status: "filled"; fillPrice: bigint }
  | { status: "rejected"; reason: string }
  | { status: "expired" }
  | { status: "pending" };

/** Polls until the committed order is executed, rejected or cancelled (or `timeoutMs` passes). */
export async function waitForOrder(
  provider: Provider,
  marketId: number,
  trader: string,
  fromBlock: number,
  timeoutMs: number,
): Promise<OrderOutcome> {
  const ex = exchangeFor(provider);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    const [executed, cancelled] = await Promise.all([
      ex.queryFilter(ex.filters.OrderExecuted(marketId, trader), fromBlock),
      ex.queryFilter(ex.filters.OrderCancelled(marketId, trader), fromBlock),
    ]);
    if (executed.length) {
      const fills = await ex.queryFilter(ex.filters.PositionModified(marketId, trader), executed[0].blockNumber);
      const fill = fills.find((f) => f.transactionHash === executed[0].transactionHash);
      return { status: "filled", fillPrice: fill && "args" in fill ? (fill.args.fillPrice as bigint) : 0n };
    }
    if (cancelled.length) {
      const c = cancelled[0];
      const reason = "args" in c ? (c.args.reason as string) : "0x";
      if (reason === "0x") return { status: "expired" };
      const err = ex.interface.parseError(reason);
      return { status: "rejected", reason: err ? humanize(err.name) : reason };
    }
  }
  return { status: "pending" };
}

const REASONS: Record<string, string> = {
  SlippageExceeded: "price moved past your slippage limit",
  InsufficientMargin: "not enough margin at the execution price",
  MarginBelowMinimum: "margin below the minimum",
  PositionUnderwater: "position is underwater (awaiting liquidation)",
  OpenInterestCapExceeded: "market open-interest cap reached",
  InsufficientLiquidity: "not enough vault liquidity",
  MarketNotActive: "market is close-only",
  EnforcedPause: "exchange is paused",
  NothingToReduce: "no position left to reduce",
};
const humanize = (name: string) => REASONS[name] ?? name;

export async function addMargin(s: Signer, marketId: number, feedId: string, amount: bigint) {
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).addMargin(marketId, amount, update, { value })).wait();
}

export async function liquidate(s: Signer, marketId: number, feedId: string, trader: string) {
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).liquidate(marketId, trader, update, { value })).wait();
}

export async function addLiquidity(s: Signer, tokenAmount: bigint, feedIds: string[]) {
  await ensureAllowance(s, tokenAmount);
  const { update, value } = await withUpdate(s, feedIds);
  await (await exchangeFor(s).addLiquidity(tokenAmount, 0n, update, { value })).wait();
}

export async function removeLiquidity(s: Signer, shares: bigint, feedIds: string[]) {
  const { update, value } = await withUpdate(s, feedIds);
  await (await exchangeFor(s).removeLiquidity(shares, 0n, update, { value })).wait();
}

/** Feed id convention for MockOracle deployments. */
export const mockFeedId = (symbol: string) => keccakId(`MOCK:${symbol.toUpperCase()}`);

export async function createMarket(s: Signer, symbol: string, feedId: string, initialPrice?: bigint) {
  if (deployment!.oracleType === "mock" && initialPrice) {
    const oracle = new Contract(deployment!.oracle, MOCK_ORACLE_ABI, s);
    const [hasPrice] = await oracle.reports(feedId);
    if (hasPrice === 0n) await (await oracle.initPrice(feedId, initialPrice)).wait();
  }
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).createMarket(symbol.toUpperCase(), feedId, update, { value })).wait();
}
