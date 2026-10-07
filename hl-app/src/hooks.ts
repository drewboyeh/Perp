import { useCallback, useEffect, useState } from "react";
import type { Wallet } from "ethers";
import { DEXS } from "./config";
import { clearinghouseState, type ClearinghouseState } from "./hl/api";
import { loadMarkets, type Market } from "./hl/markets";
import type { Eip1193 } from "./hl/signing";
import { approveAgent, approveBuilderFee, builderFeeApproved, forgetAgent, loadAgent } from "./hl/trading";

declare global {
  interface Window {
    ethereum?: Eip1193 & {
      on?: (event: string, cb: (...args: unknown[]) => void) => void;
      removeListener?: (event: string, cb: (...args: unknown[]) => void) => void;
    };
  }
}

export function useWallet() {
  const [account, setAccount] = useState<string>();
  const provider = window.ethereum;

  useEffect(() => {
    if (!provider) return;
    provider.request({ method: "eth_accounts" }).then((a) => setAccount((a as string[])[0]?.toLowerCase()));
    const onAccounts = (...args: unknown[]) => setAccount((args[0] as string[])[0]?.toLowerCase());
    provider.on?.("accountsChanged", onAccounts);
    return () => provider.removeListener?.("accountsChanged", onAccounts);
  }, [provider]);

  const connect = useCallback(async () => {
    if (!provider) throw new Error("No browser wallet found. Install MetaMask or Rabby.");
    const a = (await provider.request({ method: "eth_requestAccounts" })) as string[];
    setAccount(a[0]?.toLowerCase());
  }, [provider]);

  return { account, provider, connect };
}

function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[]) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    const run = () =>
      fn().then(
        (d) => live && (setData(d), setError(undefined)),
        (e) => live && setError(e instanceof Error ? e.message : String(e)),
      );
    run();
    const id = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, refresh: () => setTick((t) => t + 1) };
}

export const useMarkets = () => usePoll(loadMarkets, 5_000, []);

export interface Account {
  byDex: Record<string, ClearinghouseState>;
}

export function useAccount(user?: string) {
  return usePoll<Account | undefined>(
    async () => {
      if (!user) return undefined;
      const states = await Promise.all(DEXS.map((d) => clearinghouseState(user, d)));
      return { byDex: Object.fromEntries(DEXS.map((d, i) => [d, states[i]])) };
    },
    5_000,
    [user],
  );
}

/** Whether this browser can trade for `user`, and the one-time setup that makes it so. */
export function useTrading(user?: string, provider?: Eip1193) {
  const [agent, setAgent] = useState<Wallet | null>(null);
  const [feeOk, setFeeOk] = useState<boolean>();
  useEffect(() => {
    setAgent(user ? loadAgent(user) : null);
    setFeeOk(undefined);
    if (user) builderFeeApproved(user).then(setFeeOk, () => setFeeOk(false));
  }, [user]);

  const enable = useCallback(async () => {
    if (!user || !provider) throw new Error("Connect a wallet first.");
    if (!feeOk) {
      await approveBuilderFee(provider, user);
      setFeeOk(true);
    }
    if (!agent) setAgent(await approveAgent(provider, user));
  }, [user, provider, feeOk, agent]);

  /** Runs `fn` with the trading key; resets the key if Hyperliquid no longer recognizes it. */
  const withAgent = useCallback(
    async <T,>(fn: (agent: Wallet) => Promise<T>): Promise<T> => {
      if (!agent || !user) throw new Error("Set up trading first.");
      try {
        return await fn(agent);
      } catch (e) {
        if (/does not exist/i.test(e instanceof Error ? e.message : String(e))) {
          forgetAgent(user);
          setAgent(null);
          throw new Error("This browser's trading key is no longer approved. Set up trading again.");
        }
        throw e;
      }
    },
    [agent, user],
  );

  return { ready: !!agent && feeOk === true, checking: !!user && feeOk === undefined, enable, withAgent };
}

export type Trading = ReturnType<typeof useTrading>;
export type { Market };
