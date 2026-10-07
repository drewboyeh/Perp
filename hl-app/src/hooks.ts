import { useCallback, useEffect, useState } from "react";
import { DEXS } from "./config";
import { clearinghouseState, type ClearinghouseState } from "./hl/api";
import { loadMarkets, type Market } from "./hl/markets";
import type { Eip1193 } from "./hl/signing";

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

export type { Market };
