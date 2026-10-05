// Deploys the exchange.
//
// Local (chain 31337, default ORACLE=mock): MockUSDC (open faucet) + MockOracle, seeded stock
// prices, listed markets and vault liquidity.
//
// Testnet / production (default ORACLE=pyth on any other chain): PythOracle on the chain's Pyth
// contract (PYTH_ADDRESS, or the known address for the chain). Collateral is COLLATERAL_ADDRESS
// (e.g. USDC) or, if unset, a faucet MockUSDC so testers can fund themselves; with the faucet
// token the vault is seeded with liquidity. Markets are listed from Pyth equity feeds while their
// stocks trade (run scripts/list-markets.js later for any that were closed).
const hre = require("hardhat");
const { writeDeployment, exportAbis } = require("./lib/deployments");
const { DEFAULT_TICKERS, listPythMarkets } = require("./lib/pyth-markets");

const { ethers } = hre;
const usd = (n) => ethers.parseUnits(String(n), 18);
const usdc = (n) => ethers.parseUnits(String(n), 6);

// Pyth price feed contracts by chain id (https://docs.pyth.network/price-feeds/contract-addresses/evm).
// Checked on-chain before use.
const PYTH_BY_CHAIN = {
  84532: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729", // Base Sepolia
};

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

const SEED_LIQUIDITY = usdc(2_000_000);

async function resolvePyth(chainId) {
  const address = process.env.PYTH_ADDRESS || PYTH_BY_CHAIN[Number(chainId)];
  if (!address) throw new Error(`No known Pyth contract for chain ${chainId}; set PYTH_ADDRESS`);
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at Pyth address ${address}`);
  const pyth = await ethers.getContractAt("IPyth", address);
  await pyth.getUpdateFee([]); // throws if this isn't a Pyth contract
  return address;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account: set DEPLOYER_PRIVATE_KEY");
  const { chainId } = await ethers.provider.getNetwork();
  const usePyth = (process.env.ORACLE ?? (chainId === 31337n ? "mock" : "pyth")) === "pyth";
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deploying from ${deployer.address} on chain ${chainId} (oracle: ${usePyth ? "pyth" : "mock"})`);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error("Deployer has no gas funds");

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

  // Resolve external dependencies before deploying anything.
  const pythAddress = usePyth ? await resolvePyth(chainId) : undefined;

  let collateralAddress = usePyth ? process.env.COLLATERAL_ADDRESS : undefined;
  const faucet = !collateralAddress;
  if (faucet) {
    const token = await ethers.deployContract("MockUSDC");
    await token.waitForDeployment();
    collateralAddress = await token.getAddress();
  }
  const oracle = usePyth
    ? await ethers.deployContract("PythOracle", [pythAddress])
    : await ethers.deployContract("MockOracle");
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
  console.log(`Oracle:       ${oracleAddress}${usePyth ? ` (Pyth ${pythAddress})` : ""}`);
  console.log(`Collateral:   ${collateralAddress}${faucet ? " (faucet MockUSDC)" : ""}`);

  // Save the deployment before seeding so a failed seed step doesn't lose the addresses.
  writeDeployment(chainId, {
    exchange: exchangeAddress,
    collateral: collateralAddress,
    oracle: oracleAddress,
    oracleType: usePyth ? "pyth" : "mock",
    faucet,
    startBlock,
  });
  await exportAbis(hre);
  console.log("Wrote frontend/src/config/deployments.json");

  const tickers = Object.keys(SEED_STOCKS);
  if (faucet) {
    const token = await ethers.getContractAt("MockUSDC", collateralAddress);
    await (await token.mint(deployer.address, SEED_LIQUIDITY + usdc(100 * tickers.length))).wait();
    await (await token.approve(exchangeAddress, ethers.MaxUint256)).wait();
    await (await exchange.addLiquidity(SEED_LIQUIDITY, 0, [])).wait();
    await (await exchange.deposit(usdc(100 * tickers.length))).wait(); // listing fees
    console.log(`Seeded vault with ${ethers.formatUnits(SEED_LIQUIDITY, 6)} test USDC`);
  }

  if (!usePyth) {
    await (await oracle.setPermissionlessInit(true)).wait();
    const feeds = tickers.map((s) => ethers.id(`MOCK:${s}`));
    await (await oracle.setPrices(feeds, tickers.map((s) => usd(SEED_STOCKS[s])))).wait();
    for (let i = 0; i < tickers.length; i++) {
      await (await exchange.createMarket(tickers[i], feeds[i], [])).wait();
      console.log(`Listed ${tickers[i]}`);
    }
  } else if (faucet) {
    const listed = await listPythMarkets(exchange, DEFAULT_TICKERS);
    if (listed.length < DEFAULT_TICKERS.length) {
      console.log(`Listed ${listed.length}/${DEFAULT_TICKERS.length}. During US market hours run:`);
      console.log(`  npx hardhat run scripts/list-markets.js --network ${hre.network.name}`);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
