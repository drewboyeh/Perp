import { useCallback, useEffect, useMemo, useState } from "react";
import { BrowserProvider, JsonRpcProvider, type JsonRpcSigner } from "ethers";
import { CHAIN_ID, CHAIN_NAME, EXPLORER_URL, RPC_URL } from "../config";

export function useWallet() {
  const [account, setAccount] = useState<string>();
  const [chainId, setChainId] = useState<number>();
  const readProvider = useMemo(() => new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true }), []);

  const sync = useCallback(async () => {
    if (!window.ethereum) return;
    const accounts = (await window.ethereum.request({ method: "eth_accounts" })) as string[];
    setAccount(accounts[0]);
    setChainId(Number(await window.ethereum.request({ method: "eth_chainId" })));
  }, []);

  useEffect(() => {
    sync();
    const eth = window.ethereum;
    eth?.on?.("accountsChanged", sync);
    eth?.on?.("chainChanged", sync);
    return () => {
      eth?.removeListener?.("accountsChanged", sync);
      eth?.removeListener?.("chainChanged", sync);
    };
  }, [sync]);

  const switchChain = useCallback(async () => {
    const eth = window.ethereum!;
    const hexId = `0x${CHAIN_ID.toString(16)}`;
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
    } catch {
      await eth.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: hexId,
            chainName: CHAIN_NAME,
            rpcUrls: [RPC_URL],
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            ...(EXPLORER_URL ? { blockExplorerUrls: [EXPLORER_URL] } : {}),
          },
        ],
      });
    }
    await sync();
  }, [sync]);

  const connect = useCallback(async () => {
    if (!window.ethereum) {
      alert("No browser wallet found. Install MetaMask or another EIP-1193 wallet.");
      return;
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
    if (current !== CHAIN_ID) await switchChain();
    await sync();
  }, [switchChain, sync]);

  const getSigner = useCallback(async (): Promise<JsonRpcSigner> => {
    if (!window.ethereum) throw new Error("No wallet");
    const current = Number(await window.ethereum.request({ method: "eth_chainId" }));
    if (current !== CHAIN_ID) await switchChain();
    return new BrowserProvider(window.ethereum).getSigner();
  }, [switchChain]);

  return { account, chainId, wrongChain: !!account && chainId !== CHAIN_ID, readProvider, connect, switchChain, getSigner };
}

export type Wallet = ReturnType<typeof useWallet>;
