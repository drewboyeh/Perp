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
| Traders | `modifyPosition` to open, increase, reduce, flip or close long/short positions with up to 20x leverage (per-market), and add/remove margin; `closePosition` to exit |
| Anyone | `createMarket(symbol, feedId)` to list any stock that has an oracle feed (pays a listing fee to LPs) |
| LPs | `addLiquidity` / `removeLiquidity` to the shared vault that backs every market |
| Keepers | `liquidate` any position below maintenance margin for a reward |

## How it works

**Counterparty: one shared liquidity vault.** Trades execute against the vault at the oracle price rather than an order book. LPs take the other side of the traders' *net* exposure. They earn trading fees, listing fees, funding paid by the crowded side, and trader losses; they pay out trader profits. Vault NAV is `cash − traders' unrealized PnL − traders' accrued funding`. The contract tracks per-market aggregates (net size, Σ size·entry, Σ size·fundingIndex), so NAV costs O(markets), not O(positions).

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

## Quick start (local)

Requires Node 18+.

```bash
npm install
npm test                      # 34 tests incl. randomized solvency invariant

# terminal 1: local chain
npm run node

# terminal 2: deploy, seed 10 stocks + $2M vault liquidity, write frontend config
npm run deploy:local
npm run feeder:local          # random-walk prices for every market (keeps them "open")

# terminal 3: liquidation bot (optional)
npm run keeper:local

# terminal 4: UI
cd frontend && npm install && npm run dev   # http://localhost:5173
```

In your wallet, add network `http://127.0.0.1:8545` (chain id 31337) and import one of the Hardhat test private keys that `npm run node` prints. In the UI, click your balance, then **Get 10,000 test USDC**, then **Deposit**, and you can trade. Placing an order also auto-deposits any shortfall from your wallet.

To list a new stock in dev mode, click **+ List a stock**, enter a ticker and a starting price. The feeder picks it up automatically.

## Deploying with real stock prices (Pyth)

[Pyth](https://pyth.network) publishes US equity feeds (e.g. `Equity.US.AAPL/USD`) on most EVM chains.

```bash
export RPC_URL=https://...               # target chain
export DEPLOYER_PRIVATE_KEY=0x...
export ORACLE=pyth
export PYTH_ADDRESS=0x...                # Pyth contract on that chain (see Pyth docs)
export COLLATERAL_ADDRESS=0x...          # USDC on that chain
npx hardhat run scripts/deploy.js --network custom
npx hardhat run scripts/keeper.js --network custom    # run a keeper
```

Then build the UI for that chain:

```bash
cd frontend
VITE_CHAIN_ID=<id> VITE_RPC_URL=<public rpc> VITE_CHAIN_NAME="<name>" npm run build
```

With Pyth, **+ List a stock** searches Hermes for equity feeds, so any stock Pyth covers can be listed. Users need a little native gas token for the oracle update fee.

## Tests

```bash
npm test
```

- **Accounts:** decimal scaling, withdrawals.
- **Listing:** permissionless listing, fee, duplicate/stale/missing feeds.
- **Trading:** PnL math, max leverage, slippage, averaging entry on increase, keeping entry on reduce, flips, margin moves, minimum margin, skew premium.
- **Market hours, close-only, pause:** behavior when the oracle is stale, inactive markets, and pause semantics.
- **Funding:** accrual and settlement.
- **Liquidations:** liquidation price, rewards, bad debt, blocking underwater closes.
- **Vault:** fee accrual, NAV marking, lockup, utilization caps, OI caps.
- **Pyth integration:** expo normalization, in-tx updates, fee refund, confidence check (against Pyth's `MockPyth`).
- **Solvency invariant:** 3 seeded random runs of trades, price shocks, time jumps and liquidations. After every step, `token balance == Σ accounts + Σ margins + vault cash` holds exactly, and after unwinding, every aggregate returns to zero.

Contracts compile with the npm-pinned `solc` 0.8.28 (`viaIR`), so builds work offline.

## Security and legal: read before deploying with real money

This is **unaudited** software. Before mainnet:

- **Oracle latency.** Market orders execute at the price in the caller's own oracle update. On a pull oracle, a trader can choose which recent update to submit (anything inside `maxPriceAge`) and so trade on a price they already know is out of date. Production perps (GMX, Synthetix) close this with **two-step delayed orders executed by keepers**. Add that, or keep `maxPriceAge` very short and fees above typical intra-window moves.
- **Gap risk.** Stocks gap at the open and over weekends and halts. Positions can blow through liquidation, and the vault absorbs the bad debt. Size leverage, OI caps and maintenance margin for gaps, not for intraday volatility.
- **Single shared vault.** Every market draws on the same LP capital. A permissionless listing can add a thinly covered or volatile stock. Consider governance-gated listing parameters, lower defaults for new markets, or per-market caps scaled to liquidity.
- **Admin keys.** The owner can change the oracle and the risk parameters. Use a multisig and a timelock.
- **Regulation.** Offering leveraged derivatives on equities to the public is regulated in most jurisdictions. In the US, for example, these are likely security-based swaps under SEC/CFTC rules, and retail access is heavily restricted. Get legal advice and add whatever access controls (geo-restrictions, KYC) your jurisdiction requires before offering this to anyone.
