// Vectors from the official Python SDK's tests/signing_test.py.
import { Wallet } from "ethers";
import { describe, expect, it } from "vitest";
import { USD_SEND_TYPES, signL1Action, signUserActionWithWallet, type HlSignature } from "./signing";

const wallet = new Wallet("0x0123456789012345678901234567890123456789012345678901234567890123");
const big = (h: string) => BigInt(h);
const expectSig = (got: HlSignature, r: string, s: string, v: number) => {
  // The SDK prints r/s without leading zeros; compare numerically.
  expect(big(got.r)).toBe(big(r));
  expect(big(got.s)).toBe(big(s));
  expect(got.v).toBe(v);
};

const dummy = { type: "dummy", num: 100_000_000_000 }; // float_to_int_for_hashing(1000) = 1000 * 1e8
const ethOrder = {
  type: "order",
  orders: [{ a: 1, b: true, p: "100", s: "100", r: false, t: { limit: { tif: "Gtc" } } }],
  grouping: "na",
};

describe("L1 action signing matches the Python SDK", () => {
  it("signs a dummy action", async () => {
    expectSig(
      await signL1Action(wallet, dummy, 0, true),
      "0x53749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      27,
    );
    expectSig(
      await signL1Action(wallet, dummy, 0, false),
      "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      28,
    );
  });

  it("signs an order", async () => {
    expectSig(
      await signL1Action(wallet, ethOrder, 0, true),
      "0xd65369825a9df5d80099e513cce430311d7d26ddf477f5b3a33d2806b100d78e",
      "0x2b54116ff64054968aa237c20ca9ff68000f977c93289157748a3162b6ea940e",
      28,
    );
    expectSig(
      await signL1Action(wallet, ethOrder, 0, false),
      "0x82b2ba28e76b3d761093aaded1b1cdad4960b3af30212b343fb2e6cdfa4e3d54",
      "0x6b53878fc99d26047f4d7e8c90eb98955a109f44209163f52d8dc4278cbbd9f5",
      27,
    );
  });

  it("signs an order with a client order id", async () => {
    const withCloid = { ...ethOrder, orders: [{ ...ethOrder.orders[0], c: "0x00000000000000000000000000000001" }] };
    expectSig(
      await signL1Action(wallet, withCloid, 0, true),
      "0x41ae18e8239a56cacbc5dad94d45d0b747e5da11ad564077fcac71277a946e3",
      "0x3c61f667e747404fe7eea8f90ab0e76cc12ce60270438b2058324681a00116da",
      27,
    );
  });

  it("signs with a vault address", async () => {
    const vault = "0x1719884eb866cb12b2287399b15f7db5e7d775ea";
    expectSig(
      await signL1Action(wallet, dummy, 0, true, vault),
      "0x3c548db75e479f8012acf3000ca3a6b05606bc2ec0c29c50c515066a326239",
      "0x4d402be7396ce74fbba3795769cda45aec00dc3125a984f2a9f23177b190da2c",
      28,
    );
  });
});

describe("user-signed action signing matches the Python SDK", () => {
  it("signs a USD transfer", async () => {
    const action = {
      type: "usdSend",
      signatureChainId: "0x66eee",
      hyperliquidChain: "Testnet",
      destination: "0x5e9ee1089755c3435139848e47e6635505d5a13a",
      amount: "1",
      time: 1687816341423,
    };
    expectSig(
      await signUserActionWithWallet(wallet, "HyperliquidTransaction:UsdSend", USD_SEND_TYPES, action),
      "0x637b37dd731507cdd24f46532ca8ba6eec616952c56218baeff04144e4a77073",
      "0x11a6a24900e6e314136d2592e2f8d502cd89b7c15b198e1bee043c9589f9fad7",
      27,
    );
  });
});
