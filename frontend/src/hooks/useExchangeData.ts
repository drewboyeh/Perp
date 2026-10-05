import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract, type Provider } from "ethers";
import { deployment, ERC20_ABI, EXCHANGE_ABI } from "../config";

export interface MarketParams {
  maxLeverage: bigint;
  maintenanceMargin: bigint;
  takerFee: bigint;
  maxOpenInterest: bigint;
  skewScale: bigint;
  maxFundingRate: bigint;
}

export interface Market {
  id: number;
  symbol: string;
  feedId: string;
  active: boolean;
  creator: string;
  params: MarketParams;
  price: bigint;
  publishTime: number;
  priceFresh: boolean;
  longOpenInterest: bigint;
  shortOpenInterest: bigint;
  fundingRate: bigint;
}

export interface Position {
  marketId: number;
  symbol: string;
  size: bigint;
  margin: bigint;
  entryPrice: bigint;
  markPrice: bigint;
  unrealizedPnl: bigint;
  accruedFunding: bigint;
  equity: bigint;
  notional: bigint;
  leverage: bigint;
  liquidationPrice: bigint;
  liquidatable: boolean;
}

export interface PendingOrder {
  marketId: number;
  symbol: string;
  sizeDelta: bigint;
  marginDelta: bigint;
  acceptablePrice: bigint;
  keeperFee: bigint;
  commitTime: number;
  reduceOnly: boolean;
  executableAt: number;
  expiresAt: number;
}

export interface OrderConfig {
  minDelay: number;
  maxDelay: number;
  keeperFee: bigint;
}

export interface Risk {
  maxPriceAge: bigint;
  maxConfidenceRatio: bigint;
  maxUtilization: bigint;
  minPositionMargin: bigint;
  liquidationFee: bigint;
  minLiquidationReward: bigint;
  lpLockup: bigint;
  listingFee: bigint;
}

export interface Vault {
  balance: bigint;
  nav: bigint;
  totalShares: bigint;
  totalSkewNotional: bigint;
}

export interface AccountData {
  balance: bigint; // exchange account, WAD
  walletBalance: bigint; // collateral tokens, token decimals
  allowance: bigint;
  lpShares: bigint;
  lpUnlockTime: number;
  positions: Position[];
  orders: PendingOrder[];
}

export type PriceHistory = Record<number, { t: number; p: number }[]>;

const POLL_MS = 2500;
const HISTORY_LEN = 240;

// ethers Results are array-like proxies; copy the fields we need into plain objects.
type Row = Record<string, unknown>;
const mapMarket = (m: Row): Market => {
  const p = m.params as Row;
  return {
    id: Number(m.id),
    symbol: m.symbol as string,
    feedId: m.feedId as string,
    active: m.active as boolean,
    creator: m.creator as string,
    params: {
      maxLeverage: p.maxLeverage as bigint,
      maintenanceMargin: p.maintenanceMargin as bigint,
      takerFee: p.takerFee as bigint,
      maxOpenInterest: p.maxOpenInterest as bigint,
      skewScale: p.skewScale as bigint,
      maxFundingRate: p.maxFundingRate as bigint,
    },
    price: m.price as bigint,
    publishTime: Number(m.publishTime),
    priceFresh: m.priceFresh as boolean,
    longOpenInterest: m.longOpenInterest as bigint,
    shortOpenInterest: m.shortOpenInterest as bigint,
    fundingRate: m.fundingRate as bigint,
  };
};
const mapOrder = (v: Row): PendingOrder => {
  const o = v.order as Row;
  return {
    marketId: Number(v.marketId),
    symbol: v.symbol as string,
    sizeDelta: o.sizeDelta as bigint,
    marginDelta: o.marginDelta as bigint,
    acceptablePrice: o.acceptablePrice as bigint,
    keeperFee: o.keeperFee as bigint,
    commitTime: Number(o.commitTime),
    reduceOnly: o.reduceOnly as boolean,
    executableAt: Number(v.executableAt),
    expiresAt: Number(v.expiresAt),
  };
};
const mapPosition = (p: Row): Position => ({
  marketId: Number(p.marketId),
  symbol: p.symbol as string,
  size: p.size as bigint,
  margin: p.margin as bigint,
  entryPrice: p.entryPrice as bigint,
  markPrice: p.markPrice as bigint,
  unrealizedPnl: p.unrealizedPnl as bigint,
  accruedFunding: p.accruedFunding as bigint,
  equity: p.equity as bigint,
  notional: p.notional as bigint,
  leverage: p.leverage as bigint,
  liquidationPrice: p.liquidationPrice as bigint,
  liquidatable: p.liquidatable as boolean,
});

export function useExchangeData(provider: Provider, account?: string) {
  const exchange = useMemo(
    () => (deployment ? new Contract(deployment.exchange, EXCHANGE_ABI, provider) : undefined),
    [provider],
  );
  const token = useMemo(
    () => (deployment ? new Contract(deployment.collateral, ERC20_ABI, provider) : undefined),
    [provider],
  );

  const [markets, setMarkets] = useState<Market[]>([]);
  const [vault, setVault] = useState<Vault>();
  const [risk, setRisk] = useState<Risk>();
  const [orderConfig, setOrderConfig] = useState<OrderConfig>();
  const [accountData, setAccountData] = useState<AccountData>();
  const [tokenDecimals, setTokenDecimals] = useState(6);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<PriceHistory>({});
  // Chain clock minus wall clock (seconds). Order delays and oracle ages are judged on chain time.
  const [clockOffset, setClockOffset] = useState(0);
  const accountRef = useRef(account);
  accountRef.current = account;

  const refresh = useCallback(async () => {
    if (!exchange || !token) return;
    try {
      const [rawMarkets, vaultBalance, nav, totalShares, skew, rawRisk, rawOrderCfg, block] = await Promise.all([
        exchange.getMarkets(),
        exchange.vaultBalance(),
        exchange.vaultNav(),
        exchange.totalLpShares(),
        exchange.totalSkewNotional(),
        exchange.risk(),
        exchange.orderConfig(),
        provider.getBlock("latest"),
      ]);
      if (block) setClockOffset(block.timestamp - Date.now() / 1000);
      const oc = rawOrderCfg as Row;
      setOrderConfig({ minDelay: Number(oc.minDelay), maxDelay: Number(oc.maxDelay), keeperFee: oc.keeperFee as bigint });
      const ms = (rawMarkets as Row[]).map(mapMarket);
      setMarkets(ms);
      setVault({ balance: vaultBalance, nav, totalShares, totalSkewNotional: skew });
      const r = rawRisk as Row;
      setRisk({
        maxPriceAge: r.maxPriceAge as bigint,
        maxConfidenceRatio: r.maxConfidenceRatio as bigint,
        maxUtilization: r.maxUtilization as bigint,
        minPositionMargin: r.minPositionMargin as bigint,
        liquidationFee: r.liquidationFee as bigint,
        minLiquidationReward: r.minLiquidationReward as bigint,
        lpLockup: r.lpLockup as bigint,
        listingFee: r.listingFee as bigint,
      });
      const now = Date.now();
      setHistory((h) => {
        const next: PriceHistory = { ...h };
        for (const m of ms) {
          if (m.price === 0n) continue;
          const series = next[m.id] ?? [];
          const p = Number(m.price) / 1e18;
          if (series.length && series[series.length - 1].p === p) continue;
          next[m.id] = [...series, { t: now, p }].slice(-HISTORY_LEN);
        }
        return next;
      });

      const acct = accountRef.current;
      if (acct) {
        const [balance, walletBalance, allowance, lpShares, lpUnlockTime, positions, orders] = await Promise.all([
          exchange.balances(acct),
          token.balanceOf(acct),
          token.allowance(acct, deployment!.exchange),
          exchange.lpShares(acct),
          exchange.lpUnlockTime(acct),
          exchange.getPositions(acct),
          exchange.getOrders(acct),
        ]);
        if (acct === accountRef.current) {
          setAccountData({
            balance,
            walletBalance,
            allowance,
            lpShares,
            lpUnlockTime: Number(lpUnlockTime),
            positions: (positions as Row[]).map(mapPosition),
            orders: (orders as Row[]).map(mapOrder),
          });
        }
      } else {
        setAccountData(undefined);
      }
      setError(undefined);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [exchange, token, provider]);

  useEffect(() => {
    token?.decimals().then((d: bigint) => setTokenDecimals(Number(d))).catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, POLL_MS);
    return () => clearInterval(id);
  }, [refresh, account]);

  // Never let the estimate step backwards (a poll can return a stale block), or "ready" UI flickers.
  const lastNow = useRef(0);
  const chainNow = useCallback(() => {
    lastNow.current = Math.max(lastNow.current, Math.floor(Date.now() / 1000 + clockOffset));
    return lastNow.current;
  }, [clockOffset]);

  return { markets, vault, risk, orderConfig, chainNow, account: accountData, tokenDecimals, history, error, refresh };
}

export type ExchangeData = ReturnType<typeof useExchangeData>;
