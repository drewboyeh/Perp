# Perp Stocks on Hyperliquid

A branded front end for trading US stock and pre-IPO perpetuals that already exist on Hyperliquid's builder-deployed (HIP-3) markets, such as Trade.xyz. You hold no liquidity, run no oracle and take no side of any trade: orders go to Hyperliquid's order books, and every order carries your **builder code**, so Hyperliquid pays your app fee to your address.

## How it works

- **Markets:** read from Hyperliquid's public `/info` API for the dexs in `VITE_DEXS` (default `xyz`). Tickers in `VITE_PRE_IPO` appear under the Pre-IPO tab, everything else under Stocks.
- **One-time setup per user, two wallet signatures:**
  1. approve your builder fee (`approveBuilderFee`), at most 0.1% on perps;
  2. approve a trading key (`approveAgent`) that the app generates and keeps in the browser. It signs orders without wallet pop-ups and can never withdraw.
- **Orders:** market orders are IOC limit orders at mid ± 1% slippage with your builder code attached. Leverage is set per order (`updateLeverage`; isolated where the market requires it). Positions can be closed with one click.
- **Funding:** users deposit USDC and make it available to the dex on Hyperliquid's own app; the order panel links there when their balance on the dex is empty.

Signing is a port of the official Python SDK and is tested against its published signature vectors (`src/hl/signing.test.ts`).

## Run it

```bash
cd hl-app
npm install
cp .env.example .env        # set VITE_BUILDER_ADDRESS and your fee
npm run dev                 # http://localhost:5174 (mainnet)
npm run dev:testnet         # Hyperliquid testnet
npm test                    # signing + formatting tests
npm run build               # static site in dist/, host anywhere
```

## Earning fees

1. Pick a builder address you control (a fresh wallet is fine) and put it in `VITE_BUILDER_ADDRESS`.
2. Deposit at least 100 USDC into that address's Hyperliquid perps account; Hyperliquid requires it to receive builder fees.
3. Set `VITE_BUILDER_FEE` in tenths of a basis point (30 = 0.03%). Users approve this rate once.

At 0.03%, every $1M of volume through the app earns $300.

## Before you launch

- Check which markets the dexs list today and update `VITE_PRE_IPO`; listings change.
- Block US persons and other restricted regions (in the app and your terms). Charging fees on derivatives trades is regulated activity in many places; get legal advice.
- The trading key is stored in `localStorage`. Anyone with access to the browser profile can place orders (not withdraw) until the user revokes the key on Hyperliquid.
