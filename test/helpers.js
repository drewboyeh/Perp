const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const WAD = 10n ** 18n;
const usd = (n) => ethers.parseUnits(String(n), 18);
const usdc = (n) => ethers.parseUnits(String(n), 6);
const feed = (symbol) => ethers.id(`MOCK:${symbol}`);

const DEFAULT_RISK = {
  maxPriceAge: 60n,
  maxConfidenceRatio: usd("0.02"),
  maxUtilization: usd(1),
  minPositionMargin: usd(10),
  liquidationFee: usd("0.005"),
  minLiquidationReward: usd(1),
  lpLockup: 3600n,
  listingFee: usd(100),
};

const DEFAULT_PARAMS = {
  maxLeverage: usd(20),
  maintenanceMargin: usd("0.025"),
  takerFee: usd("0.001"),
  maxOpenInterest: usd(5_000_000),
  skewScale: usd(1_000_000_000),
  maxFundingRate: usd("0.001"),
};

const DEFAULT_ORDER = {
  minDelay: 2n,
  maxDelay: 60n,
  keeperFee: 0n,
};

async function deployFixture() {
  const [owner, lp, alice, bob, carol, liquidator] = await ethers.getSigners();

  const usdcToken = await ethers.deployContract("MockUSDC");
  const oracle = await ethers.deployContract("MockOracle");
  const exchange = await ethers.deployContract("PerpExchange", [
    await usdcToken.getAddress(),
    await oracle.getAddress(),
    DEFAULT_RISK,
    DEFAULT_PARAMS,
    DEFAULT_ORDER,
  ]);

  for (const s of [owner, lp, alice, bob, carol, liquidator]) {
    await usdcToken.mint(s.address, usdc(10_000_000));
    await usdcToken.connect(s).approve(await exchange.getAddress(), ethers.MaxUint256);
  }

  await oracle.setPrice(feed("AAPL"), usd(200));
  await oracle.setPrice(feed("TSLA"), usd(250));

  await exchange.connect(lp).addLiquidity(usdc(1_000_000), 0, []);
  await exchange.connect(owner).deposit(usdc(1_000));
  await exchange.connect(owner).createMarket("AAPL", feed("AAPL"), []);

  return { exchange, oracle, usdcToken, owner, lp, alice, bob, carol, liquidator };
}

/** Re-publishes a MockOracle feed at its current price so it postdates any pending commit. */
async function refreshPrice(exchange, marketId) {
  const [owner] = await ethers.getSigners();
  const oracle = await ethers.getContractAt("MockOracle", await exchange.oracle(), owner);
  const { feedId } = await exchange.getMarket(marketId);
  const [price] = await oracle.reports(feedId);
  await oracle.setPrice(feedId, price);
}

/**
 * Waits out the order delay, refreshes the oracle and executes `trader`'s pending order as a keeper.
 * Resolves to the receipt; throws `Order cancelled: <ErrorName>` if execution rejected the order.
 */
async function execute(exchange, trader, marketId) {
  const signers = await ethers.getSigners();
  const keeper = signers[6];
  const { minDelay } = await exchange.orderConfig();
  await time.increase(minDelay);
  await refreshPrice(exchange, marketId);
  const rc = await (await exchange.connect(keeper).executeOrder(marketId, trader, [])).wait();
  for (const log of rc.logs) {
    let parsed;
    try {
      parsed = exchange.interface.parseLog(log);
    } catch {}
    if (parsed?.name === "OrderCancelled") {
      const err = exchange.interface.parseError(parsed.args.reason);
      throw new Error(`Order cancelled: ${err ? err.name : parsed.args.reason}`);
    }
  }
  return rc;
}

/** Commit + execute an order with a permissive acceptable price. */
async function trade(exchange, signer, marketId, sizeDelta, marginDelta, opts = {}) {
  const acceptable = opts.acceptablePrice ?? (sizeDelta >= 0n ? ethers.MaxUint256 : 0n);
  await (
    await exchange.connect(signer).commitOrder(marketId, sizeDelta, marginDelta, acceptable, opts.reduceOnly ?? false)
  ).wait();
  return execute(exchange, signer.address, marketId);
}

/** Close the whole position with a reduce-only order. */
async function close(exchange, signer, marketId) {
  const { size } = await exchange.positions(marketId, signer.address);
  return trade(exchange, signer, marketId, -size, 0n, { reduceOnly: true });
}

/** Asserts that a commit reverted, or an execution cancelled the order, with error `name`. */
async function expectFail(promise, name) {
  try {
    await promise;
  } catch (e) {
    if (!String(e.message).includes(name)) throw new Error(`expected ${name}, got: ${e.message}`);
    return;
  }
  throw new Error(`expected failure ${name}, but it succeeded`);
}

module.exports = {
  WAD,
  usd,
  usdc,
  feed,
  DEFAULT_RISK,
  DEFAULT_PARAMS,
  DEFAULT_ORDER,
  deployFixture,
  refreshPrice,
  execute,
  trade,
  close,
  expectFail,
};
