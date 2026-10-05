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

**Counterparty: one shared liquidity vault.** Trades execute against the vault at the oracle price rather than an order book. LPs take the other side of the traders' *net* exposure. They earn trading fees, listing fees, funding paid by the crowded side, and trader losses; they pay out trader profits. Vault NAV is `cash − traders' unrealized PnL − traders' accrued funding`. The contract tracks per-market aggregates (net size, Σ size·entry, Σ size·fundingIndex), so NAV costs O(markets), not O(positions).

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

**Market hours.** Every trade, listing and liquidation needs an oracle price no older than `maxPriceAge` and within `maxConfidenceRatio`. Pyth equity feeds only publish while their market trades, so trading pauses on its own when the market closes. The UI shows these markets as "Market closed".

**Pull oracle.** With Pyth, each state-changing call accepts `bytes[] priceUpdate` and the update fee as `msg.value`. Any excess ETH is refunded. The UI and keeper fetch signed updates from Pyth Hermes.

**Admin (owner).** The owner can tune per-market and default parameters, switch markets to close-only, pause new risk, and change the oracle. Pausing never blocks withdrawals, closing, reducing, or liquidations. Ownership uses `Ownable2Step`. In production the owner should be a multisig behind a timelock.

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
| Max price age | 300s local, 60s Pyth |
| LP lockup | 60s local, 24h Pyth |
| Order delay (min / expiry) | 1s / 120s local, 2s / 60s Pyth |
| Keeper fee | $0.50 per order |

## Quick start (local)

Requires Node 18+.

```bash
npm install
npm test                      # 44 tests incl. randomized solvency invariant

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

## Deploying to Base Sepolia (testnet, real Pyth prices)

The testnet deployment uses live [Pyth](https://pyth.network) US equity prices (e.g. `Equity.US.AAPL/USD`) and a faucet test-USDC as collateral, so anyone can fund themselves.

**Prerequisites**
- A **fresh, throwaway** deployer key funded with a little Base Sepolia ETH (0.05 is plenty) from any Base Sepolia faucet. It becomes the contracts' owner.
- Network access to `sepolia.base.org` (or set `BASE_SEPOLIA_RPC_URL`) and `hermes.pyth.network`.

```bash
export DEPLOYER_PRIVATE_KEY=0x...        # never commit this
npm run deploy:base-sepolia
```

The script:
- checks the Base Sepolia Pyth contract on-chain;
- deploys `MockUSDC` (faucet), `PythOracle` and `PerpExchange`;
- seeds the vault with 2,000,000 test USDC;
- lists 10 stocks from Pyth feeds;
- writes the addresses to `frontend/src/config/deployments.json`. Commit that file so the UI knows the deployment.

Listing needs a fresh price, so stocks only list during US market hours (9:30–16:00 ET, Mon–Fri); closed ones are skipped. Re-run later to list them; this is safe to repeat:

```bash
npm run list-markets:base-sepolia                    # or TICKERS=COIN,PLTR npm run list-markets:base-sepolia
```

**Keeper.** Run it on any always-on machine with a funded key. It fills orders (earning keeper fees), cancels expired ones, liquidates, and pushes fresh Pyth prices on-chain every 30s while markets trade (Pyth is a pull oracle, so on-chain prices otherwise go stale):

```bash
npm run keeper:base-sepolia
```

Without a keeper the app still works: it shows live prices straight from Pyth, and traders can execute their own orders from **Pending orders**.

**Frontend.**

```bash
cd frontend
npm run dev:base-sepolia      # local dev against Base Sepolia
npm run build:base-sepolia    # static build in frontend/dist, host anywhere
```

Settings live in `frontend/.env.base-sepolia`.

**Other chains / real USDC.** Set `PYTH_ADDRESS` (see Pyth's contract-address docs) and optionally `COLLATERAL_ADDRESS` (e.g. real USDC, which turns off the faucet and the vault seeding). Then run `npx hardhat run scripts/deploy.js --network custom` with `RPC_URL` set. In the UI, **+ List a stock** searches Pyth for any covered equity.

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
- **Vault:** fee accrual, NAV marking, lockup, utilization caps, OI caps.
- **Pyth integration:** expo normalization, in-tx updates, fee refund, confidence check, and an order that only fills once a keeper submits a post-commit price (against Pyth's `MockPyth`).
- **Solvency invariant:** 3 seeded random runs of trades, orders left pending to execute late, fail or expire, price shocks, time jumps and liquidations. Order escrow counts toward the balance check. After every step, `token balance == Σ accounts + Σ margins + vault cash` holds exactly, and after unwinding, every aggregate returns to zero.

Contracts compile with the npm-pinned `solc` 0.8.28 (`viaIR`), so builds work offline.

## Security and legal: read before deploying with real money

This is **unaudited** software. Before mainnet:

- **Oracle latency.** Two-step orders stop traders from filling at a price they already know. Some optionality remains: within the `minDelay`–`maxDelay` window, a trader who executes their own order could wait for a favourable price, as long as no keeper beats them to it. Keep `maxDelay` short and run competitive keepers. Liquidations and LP deposits/withdrawals still use the latest on-chain price. LP deposits are protected by the lockup; LP withdrawals could also move to a delayed flow.
- **Gap risk.** Stocks gap at the open and over weekends and halts. Positions can blow through liquidation, and the vault absorbs the bad debt. Size leverage, OI caps and maintenance margin for gaps, not for intraday volatility.
- **Single shared vault.** Every market draws on the same LP capital. A permissionless listing can add a thinly covered or volatile stock. Consider governance-gated listing parameters, lower defaults for new markets, or per-market caps scaled to liquidity.
- **Admin keys.** The owner can change the oracle and the risk parameters. Use a multisig and a timelock.
- **Regulation.** Offering leveraged derivatives on equities to the public is regulated in most jurisdictions. In the US, for example, these are likely security-based swaps under SEC/CFTC rules, and retail access is heavily restricted. Get legal advice and add whatever access controls (geo-restrictions, KYC) your jurisdiction requires before offering this to anyone.
