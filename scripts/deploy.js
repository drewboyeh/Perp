// Deploys the exchange.
//
// Local / testnet (default): deploys MockUSDC (open faucet) + MockOracle, seeds stock prices,
// lists markets and seeds vault liquidity.
//
// Production-style: set ORACLE=pyth with PYTH_ADDRESS and COLLATERAL_ADDRESS (e.g. USDC) to
// deploy against real Pyth equity feeds. Markets are then listed by anyone via the UI.
const hre = require("hardhat");
const { writeDeployment, exportAbis } = require("./lib/deployments");

const { ethers } = hre;
const usd = (n) => ethers.parseUnits(String(n), 18);

const SEED_STOCKS = {
  AAPL: 230,
  MSFT: 430,
  NVDA: 180,
  TSLA: 250,
  AMZN: 220,
  GOOGL: 240,
  META: 700,
  NFLX: 1200,
  AMD: 160,
  SPY: 660,
};

const MARKET_PARAMS = {
  maxLeverage: usd(20),
  maintenanceMargin: usd("0.025"),
  takerFee: usd("0.001"),
  maxOpenInterest: usd(5_000_000),
  skewScale: usd(500_000_000),
  maxFundingRate: usd("0.001"),
};

async function main() {
  const [deployer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const usePyth = process.env.ORACLE === "pyth";
  console.log(`Deploying from ${deployer.address} on chain ${chainId} (oracle: ${usePyth ? "pyth" : "mock"})`);

  const risk = {
    maxPriceAge: usePyth ? 60n : 300n,
    maxConfidenceRatio: usd("0.02"),
    maxUtilization: usd(1),
    minPositionMargin: usd(10),
    liquidationFee: usd("0.005"),
    minLiquidationReward: usd(1),
    lpLockup: usePyth ? 86_400n : 60n,
    listingFee: usd(100),
  };

  // Two-step orders: execute no sooner than minDelay after commit, at a price published after it.
  const orderConfig = {
    minDelay: usePyth ? 2n : 1n,
    maxDelay: usePyth ? 60n : 120n,
    keeperFee: usd("0.5"),
  };

  let collateralAddress;
  let oracle;
  if (usePyth) {
    const { PYTH_ADDRESS, COLLATERAL_ADDRESS } = process.env;
    if (!PYTH_ADDRESS || !COLLATERAL_ADDRESS) throw new Error("ORACLE=pyth requires PYTH_ADDRESS and COLLATERAL_ADDRESS");
    collateralAddress = COLLATERAL_ADDRESS;
    oracle = await ethers.deployContract("PythOracle", [PYTH_ADDRESS]);
  } else {
    const token = await ethers.deployContract("MockUSDC");
    await token.waitForDeployment();
    collateralAddress = await token.getAddress();
    oracle = await ethers.deployContract("MockOracle");
  }
  await oracle.waitForDeployment();
  const oracleAddress = await oracle.getAddress();

  const exchange = await ethers.deployContract("PerpExchange", [
    collateralAddress,
    oracleAddress,
    risk,
    MARKET_PARAMS,
    orderConfig,
  ]);
  await exchange.waitForDeployment();
  const exchangeAddress = await exchange.getAddress();
  const startBlock = (await exchange.deploymentTransaction().wait()).blockNumber;
  console.log(`PerpExchange: ${exchangeAddress}`);
  console.log(`Oracle:       ${oracleAddress}`);
  console.log(`Collateral:   ${collateralAddress}`);

  if (!usePyth) {
    const token = await ethers.getContractAt("MockUSDC", collateralAddress);
    await (await oracle.setPermissionlessInit(true)).wait();
    const symbols = Object.keys(SEED_STOCKS);
    const feeds = symbols.map((s) => ethers.id(`MOCK:${s}`));
    await (await oracle.setPrices(feeds, symbols.map((s) => usd(SEED_STOCKS[s])))).wait();

    await (await token.mint(deployer.address, ethers.parseUnits("5000000", 6))).wait();
    await (await token.approve(exchangeAddress, ethers.MaxUint256)).wait();
    await (await exchange.addLiquidity(ethers.parseUnits("2000000", 6), 0, [])).wait();
    await (await exchange.deposit(ethers.parseUnits(String(100 * symbols.length), 6))).wait();
    for (let i = 0; i < symbols.length; i++) {
      await (await exchange.createMarket(symbols[i], feeds[i], [])).wait();
      console.log(`Listed ${symbols[i]}`);
    }
  }

  writeDeployment(chainId, {
    exchange: exchangeAddress,
    collateral: collateralAddress,
    oracle: oracleAddress,
    oracleType: usePyth ? "pyth" : "mock",
    startBlock,
  });
  await exportAbis(hre);
  console.log("Wrote frontend/src/config/deployments.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
