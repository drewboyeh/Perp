import { Contract, MaxUint256, id as keccakId, type Signer } from "ethers";
import { deployment, ERC20_ABI, EXCHANGE_ABI, MOCK_ORACLE_ABI } from "../config";
import { getPriceUpdate } from "./oracle";

const exchangeFor = (s: Signer) => new Contract(deployment!.exchange, EXCHANGE_ABI, s);
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

export async function modifyPosition(
  s: Signer,
  marketId: number,
  feedId: string,
  sizeDelta: bigint,
  marginDelta: bigint,
  acceptablePrice: bigint,
) {
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).modifyPosition(marketId, sizeDelta, marginDelta, acceptablePrice, update, { value })).wait();
}

export async function closePosition(s: Signer, marketId: number, feedId: string, acceptablePrice: bigint) {
  const { update, value } = await withUpdate(s, [feedId]);
  await (await exchangeFor(s).closePosition(marketId, acceptablePrice, update, { value })).wait();
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
