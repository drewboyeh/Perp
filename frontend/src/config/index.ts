import deployments from "./deployments.json";
import abis from "./abis.json";

export type OracleType = "mock" | "pyth";

export interface Deployment {
  exchange: string;
  collateral: string;
  oracle: string;
  oracleType: OracleType;
  startBlock: number;
}

export const CHAIN_ID = Number(import.meta.env.VITE_CHAIN_ID ?? 31337);
export const RPC_URL: string = import.meta.env.VITE_RPC_URL ?? "http://127.0.0.1:8545";
export const HERMES_URL: string = import.meta.env.VITE_HERMES_URL ?? "https://hermes.pyth.network";
export const CHAIN_NAME: string = import.meta.env.VITE_CHAIN_NAME ?? (CHAIN_ID === 31337 ? "Localhost" : `Chain ${CHAIN_ID}`);

export const deployment: Deployment | undefined = (deployments as Record<string, Deployment>)[String(CHAIN_ID)];

export const EXCHANGE_ABI = abis.PerpExchange;
export const MOCK_ORACLE_ABI = abis.MockOracle;
export const ERC20_ABI = abis.MockUSDC;
