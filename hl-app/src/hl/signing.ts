// Hyperliquid request signing, ported from the official Python SDK (hyperliquid/utils/signing.py).
//
// Two schemes:
//  - L1 actions (orders, cancels, leverage): msgpack(action) + nonce + vault flag is hashed into a
//    "phantom agent" and signed as EIP-712 on chain id 1337. Browser wallets refuse that chain id,
//    so these are signed by a local agent key the user approves once (see approveAgent).
//  - User-signed actions (approveAgent, approveBuilderFee, transfers): EIP-712 on the wallet's
//    current chain id, signed by the user's wallet.
import { encode } from "@msgpack/msgpack";
import { Signature, TypedDataEncoder, concat, getBytes, keccak256, toBeHex, type Wallet } from "ethers";

export interface HlSignature {
  r: string;
  s: string;
  v: number;
}

type TypedField = { name: string; type: string };

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EIP712_DOMAIN: TypedField[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** keccak256(msgpack(action) ‖ nonce(8 bytes BE) ‖ vault flag [‖ address] [‖ 0x00 ‖ expiresAfter]). */
export function actionHash(action: unknown, vaultAddress: string | null, nonce: number, expiresAfter?: number): string {
  const parts: Uint8Array[] = [encode(action), getBytes(toBeHex(nonce, 8))];
  if (vaultAddress) parts.push(new Uint8Array([1]), getBytes(vaultAddress));
  else parts.push(new Uint8Array([0]));
  if (expiresAfter !== undefined) parts.push(new Uint8Array([0]), getBytes(toBeHex(expiresAfter, 8)));
  return keccak256(concat(parts));
}

export function l1TypedData(hash: string, isMainnet: boolean) {
  return {
    domain: { chainId: 1337, name: "Exchange", verifyingContract: ZERO_ADDRESS, version: "1" },
    types: {
      Agent: [
        { name: "source", type: "string" },
        { name: "connectionId", type: "bytes32" },
      ],
    },
    primaryType: "Agent" as const,
    message: { source: isMainnet ? "a" : "b", connectionId: hash },
  };
}

const toHlSignature = (sig: string): HlSignature => {
  const s = Signature.from(sig);
  return { r: s.r, s: s.s, v: s.v };
};

/** Signs an L1 action with a local key (the approved agent). */
export async function signL1Action(
  wallet: Wallet,
  action: unknown,
  nonce: number,
  isMainnet: boolean,
  vaultAddress: string | null = null,
  expiresAfter?: number,
): Promise<HlSignature> {
  const { domain, types, message } = l1TypedData(actionHash(action, vaultAddress, nonce, expiresAfter), isMainnet);
  return toHlSignature(await wallet.signTypedData(domain, types, message));
}

export function userSignedTypedData(primaryType: string, fields: TypedField[], action: Record<string, unknown>) {
  const chainId = Number(BigInt(action.signatureChainId as string));
  return {
    domain: { name: "HyperliquidSignTransaction", version: "1", chainId, verifyingContract: ZERO_ADDRESS },
    types: { [primaryType]: fields },
    primaryType,
    message: action,
  };
}

/** EIP-1193 provider (window.ethereum). */
export interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Signs a user-signed action with the user's browser wallet via eth_signTypedData_v4. */
export async function signUserAction(
  provider: Eip1193,
  user: string,
  primaryType: string,
  fields: TypedField[],
  action: Record<string, unknown>,
): Promise<HlSignature> {
  const td = userSignedTypedData(primaryType, fields, action);
  // Only the declared fields are part of the signed message.
  const message = Object.fromEntries(fields.map((f) => [f.name, action[f.name]]));
  const payload = { ...td, message, types: { EIP712Domain: EIP712_DOMAIN, ...td.types } };
  const sig = (await provider.request({
    method: "eth_signTypedData_v4",
    params: [user, JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v))],
  })) as string;
  return toHlSignature(sig);
}

/** Same as signUserAction with a local key (used in tests). */
export async function signUserActionWithWallet(
  wallet: Wallet,
  primaryType: string,
  fields: TypedField[],
  action: Record<string, unknown>,
): Promise<HlSignature> {
  const { domain, types } = userSignedTypedData(primaryType, fields, action);
  const message = Object.fromEntries(fields.map((f) => [f.name, action[f.name]]));
  return toHlSignature(await wallet.signTypedData(domain, types, message));
}

/** Hash a user-signed action would have (for debugging and tests). */
export const userSignedHash = (primaryType: string, fields: TypedField[], action: Record<string, unknown>) => {
  const { domain, types } = userSignedTypedData(primaryType, fields, action);
  return TypedDataEncoder.hash(domain, types, Object.fromEntries(fields.map((f) => [f.name, action[f.name]])));
};

export const APPROVE_AGENT_TYPES: TypedField[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "agentAddress", type: "address" },
  { name: "agentName", type: "string" },
  { name: "nonce", type: "uint64" },
];

export const APPROVE_BUILDER_FEE_TYPES: TypedField[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "maxFeeRate", type: "string" },
  { name: "builder", type: "address" },
  { name: "nonce", type: "uint64" },
];

export const USD_SEND_TYPES: TypedField[] = [
  { name: "hyperliquidChain", type: "string" },
  { name: "destination", type: "string" },
  { name: "amount", type: "string" },
  { name: "time", type: "uint64" },
];
