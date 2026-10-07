# Perp Stocks

Permissionless perpetual futures on equities. Anyone can deposit, trade leveraged longs and shorts on any listed stock, list a new stock market, provide liquidity, or run a liquidation keeper.

```
contracts/            Solidity (Hardhat)
  PerpExchange.sol      accounts, markets, trading, funding, liquidations, LP vault
  oracles/PythOracle.sol  adapter for Pyth equity price feeds (production)
  oracles/MockOracle.sol  push oracle for local dev / testnets
  mocks/MockUSDC.sol      6-decimal test stablecoin with an open faucet
scripts/              deploy, dev price feeder, liquidation keeper
test/                 unit, Pyth integration, and randomized solvency-invariant tests
frontend/             React + Vite + ethers trading UI
hl-app/               front end for stock and pre-IPO perps on Hyperliquid (earns builder fees, no liquidity needed)
```

## What you can do

| Who | Action |
|---|---|
| Anyone | `deposit` / `withdraw` USDC to a trading account (withdrawals work even when paused) |
| Traders | `commitOrder` to open, increase, reduce, flip or close long/short positions with up to 20x leverage (per-market) or withdraw margin; `addMargin` to top up instantly |
| Keepers | `executeOrder` to fill committed orders after the delay (earns the keeper fee); `cancelOrder` on expired ones |
| Anyone | `createMarket(symbol, feedId)` to list any stock that has an oracle feed (pays a listing fee to LPs) |
| LPs | `addLiquidity` / `removeLiquidity` to the shared vault that backs every market |
| Keepers | `liquidate` any position below maintenance margin for a reward |

## How it works

**Counterparty: one shared liquidity vault.** Trades execute against the vault at the oracle price rather than an order book. LPs take the other side of the traders' *net* exposure. They earn trading fees (minus the protocol's share, below), listing fees, funding paid by the crowded side, and trader losses; they pay out trader profits. Vault NAV is `cash − traders' unrealized PnL − traders' accrued funding`. The contract tracks per-market aggregates (net size, Σ size·entry, Σ size·fundingIndex), so NAV costs O(markets), not O(positions).

**Two-step orders.** Trades never fill at a price the trader could see when submitting:

1. `commitOrder(market, sizeDelta, marginDelta, acceptablePrice, reduceOnly)` records the order and escrows any added margin plus a keeper fee from the trading account.
2. After `minDelay`, anyone calls `executeOrder(market, trader, priceUpdate)`. It requires an oracle price **published at least `minDelay` after the commit** (`PriceNotAfterCommit` otherwise). The fill uses that price.
3. If the order is invalid at that price (fill past `acceptablePrice`, too little margin, OI cap, market paused or close-only), it is **cancelled, not reverted**. The escrowed margin returns to the trader and the executor still earns the keeper fee, so keepers aren't stuck with failing transactions.
4. Orders expire after `maxDelay`. An order can't be cancelled before it expires, so committing is never a free option to back out when the price moves against you. After expiry anyone can `cancelOrder`; the fee goes to the caller, or back to the trader if they cancel it themselves.

Details:
- One pending order per trader per market.
- `reduceOnly` orders (the UI's Close button) are clamped to the position size at execution. If the position is gone, for example liquidated in the meantime, the order is cancelled rather than opening the opposite side.
- Execution runs in a self-call wrapped in `try/catch`. An empty revert (out-of-gas) reverts the whole transaction, so a keeper can't starve the call to force a cancel and collect the fee.
- `addMargin` stays instant because it only lowers risk and may be urgent near liquidation. Liquidations stay instant too.
- The bundled keeper (`scripts/keeper.js`) executes orders as soon as they're valid, cancels expired ones, and liquidates. In the UI, if no keeper picks up an order, the trader can execute it from **Pending orders** and keep the fee themselves.

**Pricing.** `fill = oracle × (1 + avgSkew × oracle / skewScale)`. Trades that grow the long/short imbalance fill slightly worse, and trades that shrink it fill slightly better (Synthetix-style premium, capped at ±10%). Round trips are neutral apart from fees.

**Funding.** Funding accrues continuously. `rate/day = maxFundingRate × (longOI − shortOI) / (longOI + shortOI)`. The crowded side pays, and the vault and the other side receive.

**Margin.** Margin is isolated per position, funded from your trading-account balance. Opening or increasing a position, or withdrawing margin from it, requires `equity ≥ notional / maxLeverage`. A position is liquidatable when `equity < notional × maintenanceMargin`. A position whose losses exceed its margin cannot be closed; only a liquidator can close it.

**Liquidation.** The liquidator receives `liquidationFee × notional`, capped by the position's remaining equity. If that is below `minLiquidationReward`, the vault tops it up so that liquidating is always worth doing. Any equity left after the reward goes back to the trader. Bad debt (losses greater than margin) is absorbed by the vault.

**Vault protection.**
- Per-market open-interest caps.
- Global cap: Σ |net skew notional| ≤ `maxUtilization × vault cash`. This applies to new exposure and to LP withdrawals.
- LP deposit lockup.
- LP deposits and withdrawals need fresh prices for every market with open interest, so nobody can trade the vault against stale weekend prices.
- If the vault cannot cover a profit, the payout is haircut. The `ProfitHaircut` event records it; the contract never becomes insolvent.

**Market hours.** Every trade, listing and liquidation needs an oracle price no older than `maxPriceAge` and within `maxConfidenceRatio`. Pyth equity feeds, and the testnet stock feeder, only publish while the market trades, so trading pauses on its own when the market closes. The UI shows these markets as "Market closed".

**Pull oracle.** With Pyth, each state-changing call accepts `bytes[] priceUpdate` and the update fee as `msg.value`. Any excess ETH is refunded. The UI and keeper fetch signed updates from Pyth Hermes.

**Protocol fee.** A share of every trading fee (`protocolFeeShare`, at most 50%; the deploy script sets 20%) is credited to the `treasury` address's trading account, which withdraws it like any balance. The rest goes to the vault. The owner sets both with `setProtocolFee`; a zero share sends all fees to LPs.

**Admin (owner).** The owner can tune per-market and default parameters, switch markets to close-only, pause new risk, change the oracle, and set the protocol fee. Pausing never blocks withdrawals, closing, reducing, or liquidations. Ownership uses `Ownable2Step`. In production the owner should be a multisig behind a timelock.

### Default parameters (local deploy)

| Parameter | Value |
|---|---|
| Max leverage | 20x |
| Maintenance margin | 2.5% of notional |
| Taker fee | 0.10% |
| Max OI per side | $5M |
| Max funding rate | 0.1% / day |
| Liquidation reward | 0.5% of notional (min $1) |
| Min position margin | $10 |
| Max vault utilization | 100% of vault cash |
| Listing fee | $100 |
| Max price age | 300s local, 60s testnet |
| LP lockup | 60s local, 24h testnet |
| Order delay (min / expiry) | 1s / 120s local, 2s / 90s testnet (2s / 60s with Pyth) |
| Keeper fee | $0.50 per order |
| Protocol fee | 20% of trading fees to the treasury (default: the deployer) |

## Quick start (local)

Requires Node 18+.

```bash
npm install
npm test                      # 52 tests incl. randomized solvency invariant

# terminal 1: local chain
npm run node

# terminal 2: deploy, seed 10 stocks + $2M vault liquidity, write frontend config
npm run deploy:local
npm run feeder:local          # random-walk prices for every market (keeps them "open")

# terminal 3: keeper bot: executes orders, cancels expired ones, liquidates
npm run keeper:local

# terminal 4: UI
cd frontend && npm install && npm run dev   # http://localhost:5173
```

In your wallet, add network `http://127.0.0.1:8545` (chain id 31337) and import one of the Hardhat test private keys that `npm run node` prints. In the UI, click your balance, then **Get 10,000 test USDC**, then **Deposit**, and you can trade. Placing an order also auto-deposits any shortfall from your wallet.

To list a new stock in dev mode, click **+ List a stock**, enter a ticker and a starting price. The feeder picks it up automatically.

## Deploying to Base Sepolia (testnet, live stock prices)

The testnet deployment uses a faucet test-USDC as collateral, so anyone can fund themselves. Prices come from free market-data APIs: a feeder you run pushes live US stock quotes into a `MockOracle` that only your reporter address can write to.

> Pyth's Hermes now needs a paid API key, and US equities are on its Pyth Pro plans, so the free path is the default. `ORACLE=pyth` with `PYTH_API_KEY` still deploys the Pyth version (see below). With the push oracle you are trusted to report honest prices: fine for a testnet, not for real money.

**Prerequisites**
- A **fresh, throwaway** deployer key funded with Base Sepolia ETH from any faucet. It becomes the contracts' owner, the oracle reporter and, by default, the protocol fee treasury. The feeder pushes a transaction every ~20s during market hours, so keep it topped up.
- A free [Finnhub](https://finnhub.io) API key (real-time US quotes, 60 requests/min). Optionally a free [Alpaca](https://alpaca.markets) key pair as a backup source.

```bash
export DEPLOYER_PRIVATE_KEY=0x...        # never commit these
export FINNHUB_API_KEY=...
npm run deploy:base-sepolia
```

The script deploys `MockUSDC` (faucet), `MockOracle` and `PerpExchange`, sets the protocol fee (`PROTOCOL_FEE_SHARE`, default 0.2, to `TREASURY_ADDRESS`, default the deployer), seeds the vault with 2,000,000 test USDC, lists 10 stocks at live quotes, and writes the addresses to `frontend/src/config/deployments.json`. Commit that file so the UI knows the deployment.

Listing needs a fresh quote, so stocks only list during US market hours (9:30–16:00 ET, Mon–Fri); closed ones are skipped. Re-run later to list them; this is safe to repeat:

```bash
npm run list-markets:base-sepolia                    # or TICKERS=COIN,PLTR npm run list-markets:base-sepolia
```

On testnets only the operator lists stocks this way: the oracle doesn't let strangers set a first price, since a made-up listing price could be traded against the vault.

**Feeder and keeper.** Run both on an always-on machine with the same environment variables:

```bash
npm run feeder:base-sepolia    # pushes live prices for every listed market while the market is open
npm run keeper:base-sepolia    # fills orders (earning keeper fees), cancels expired ones, liquidates
```

Without the feeder, prices go stale within 60s and trading pauses. The feeder:
- tries `PRICE_SOURCES` in order for each ticker (default `finnhub`, then `alpaca` when `ALPACA_API_KEY_ID` and `ALPACA_API_SECRET_KEY` are set); override one ticker with e.g. `PRICE_SOURCES_TSLA=alpaca,finnhub`;
- only uses quotes younger than 120s, and by default only pushes 9:30–16:00 ET (`FEEDER_HOURS=any` includes extended hours);
- holds a quote that jumps more than 15% from a still-fresh on-chain price (`FEEDER_MAX_JUMP`), until that price goes stale.

To run the feeder with a different key than the deployer's, allow it as a reporter first: `REPORTER=0x... npx hardhat run scripts/set-reporter.js --network baseSepolia` (run as the owner).

Free market-data tiers are for personal use; check the provider's terms before showing their prices publicly.

**Private-company (pre-IPO) markets.** Synthetic perps on a reference price for private companies such as OpenAI, Anthropic, Stripe or ByteDance. Nobody trades the actual shares. On-chain symbols end in `-PRE` (e.g. `OPENAI-PRE`); the UI shows them as `OPENAI-PERP` with a Pre-IPO tag and a notice that the market is synthetic and unaffiliated.

Reference prices come from `private-markets.json`, which you keep on the feeder machine and out of git (anyone who sees a new price before it reaches the chain can trade against the vault). Copy `private-markets.example.json`, fill in `price` and `asOf` (pick one price convention per market, e.g. implied valuation in $ billions), and list them:

```bash
cp private-markets.example.json private-markets.json   # then edit prices and dates
TICKERS=OPENAI-PRE,ANTHROPIC-PRE npm run list-markets:base-sepolia
```

Because these prices update about once a day and can gap on a funding round:
- they list with conservative parameters from their first block: 3x max leverage, 10% maintenance margin, 0.30% taker fee, $250k open-interest cap per side;
- the feeder re-reads the file every round and stops pushing a price older than `PRIVATE_MAX_AGE_DAYS` (default 3), which pauses trading;
- a price that moves more than `PRIVATE_MAX_JUMP` (default 20%) from the on-chain price is held, pausing the market, until you confirm it by setting `"confirmPrice"` to the same value.

For a public launch, license your reference data (e.g. Forge Price) rather than copying it, and check each company's trademark position.

**Frontend.**

```bash
cd frontend
npm run dev:base-sepolia      # local dev against Base Sepolia
npm run build:base-sepolia    # static build in frontend/dist, host anywhere
```

Settings live in `frontend/.env.base-sepolia`.

**Pyth instead (paid).** `ORACLE=pyth` deploys a `PythOracle` and lists Pyth equity feeds. Hermes requires an API key with US equity access (`PYTH_API_KEY`), which the scripts send as a Bearer token. The UI fetches Pyth prices through `/hermes` on the Vite dev/preview server, which adds `PYTH_API_KEY` server-side so the key never reaches the browser; a static build needs `VITE_HERMES_URL` pointing at a proxy that does the same. The keeper also pushes Pyth prices on-chain every 30s while markets trade.

**Other chains / real USDC.** Set `PYTH_ADDRESS` (see Pyth's contract-address docs) and optionally `COLLATERAL_ADDRESS` (e.g. real USDC, which turns off the faucet and the vault seeding). Then run `ORACLE=pyth npx hardhat run scripts/deploy.js --network custom` with `RPC_URL` set.

## Tests

```bash
npm test
```

- **Accounts:** decimal scaling, withdrawals.
- **Listing:** permissionless listing, fee, duplicate/stale/missing feeds.
- **Trading:** PnL math, max leverage, slippage, averaging entry on increase, keeping entry on reduce, flips, margin moves, minimum margin, skew premium.
- **Market hours, close-only, pause:** behavior when the oracle is stale, inactive markets, and pause semantics.
- **Funding:** accrual and settlement.
- **Delayed orders:** escrow and keeper fee, `OrderNotReady`, `PriceNotAfterCommit` (the fill uses the newer price), one order per market, rejected orders refund escrow and still pay the keeper, no cancelling before expiry, expired orders can't execute, reduce-only clamping and no flip after liquidation, instant `addMargin` while paused, self-call guard, config validation.
- **Liquidations:** liquidation price, rewards, bad debt, blocking underwater closes.
- **Private markets:** missing, stale and future-dated reference prices are held, large moves wait for confirmation, listings start with conservative parameters and restore the defaults even when listing fails.
- **Vault and protocol fee:** fee accrual, the treasury/vault fee split and its owner-only cap, NAV marking, lockup, utilization caps, OI caps.
- **Pyth integration:** expo normalization, in-tx updates, fee refund, confidence check, and an order that only fills once a keeper submits a post-commit price (against Pyth's `MockPyth`).
- **Solvency invariant:** 3 seeded random runs of trades, orders left pending to execute late, fail or expire, price shocks, time jumps and liquidations. Order escrow counts toward the balance check. With a 30% protocol fee on, after every step `token balance == Σ accounts (incl. the treasury) + Σ margins + vault cash` holds exactly, and after unwinding, every aggregate returns to zero.

Contracts compile with the npm-pinned `solc` 0.8.28 (`viaIR`), so builds work offline.

## Security and legal: read before deploying with real money

This is **unaudited** software. Before mainnet:

- **Oracle latency.** Two-step orders stop traders from filling at a price they already know. Some optionality remains: within the `minDelay`–`maxDelay` window, a trader who executes their own order could wait for a favourable price, as long as no keeper beats them to it. Keep `maxDelay` short and run competitive keepers. Liquidations and LP deposits/withdrawals still use the latest on-chain price. LP deposits are protected by the lockup; LP withdrawals could also move to a delayed flow.
- **Gap risk.** Stocks gap at the open and over weekends and halts. Positions can blow through liquidation, and the vault absorbs the bad debt. Size leverage, OI caps and maintenance margin for gaps, not for intraday volatility.
- **Single shared vault.** Every market draws on the same LP capital. A permissionless listing can add a thinly covered or volatile stock. Consider governance-gated listing parameters, lower defaults for new markets, or per-market caps scaled to liquidity.
- **Admin keys.** The owner can change the oracle and the risk parameters. Use a multisig and a timelock.
- **Regulation.** Offering leveraged derivatives on equities to the public is regulated in most jurisdictions. In the US, for example, these are likely security-based swaps under SEC/CFTC rules, and retail access is heavily restricted. Get legal advice and add whatever access controls (geo-restrictions, KYC) your jurisdiction requires before offering this to anyone.
