const { ethers } = require("hardhat");

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

async function deployFixture() {
  const [owner, lp, alice, bob, carol, liquidator] = await ethers.getSigners();

  const usdcToken = await ethers.deployContract("MockUSDC");
  const oracle = await ethers.deployContract("MockOracle");
  const exchange = await ethers.deployContract("PerpExchange", [
    await usdcToken.getAddress(),
    await oracle.getAddress(),
    DEFAULT_RISK,
    DEFAULT_PARAMS,
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

/** Trade helper with a permissive acceptable price. */
async function trade(exchange, signer, marketId, sizeDelta, marginDelta) {
  const acceptable = sizeDelta >= 0n ? ethers.MaxUint256 : 0n;
  return exchange.connect(signer).modifyPosition(marketId, sizeDelta, marginDelta, acceptable, []);
}

module.exports = { WAD, usd, usdc, feed, DEFAULT_RISK, DEFAULT_PARAMS, deployFixture, trade };
