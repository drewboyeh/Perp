// Lists Pyth-backed stock markets on an existing deployment. Run during US market hours (listing
// needs a fresh price). Tickers default to the seed set; override with TICKERS=COIN,PLTR,...
// Listing fees come from the caller's trading account; with a faucet collateral token the
// shortfall is minted and deposited automatically.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");
const { DEFAULT_TICKERS, listPythMarkets } = require("./lib/pyth-markets");

const { ethers } = hre;

async function main() {
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  if (d.oracleType !== "pyth") throw new Error("list-markets is for Pyth deployments");
  const exchange = await ethers.getContractAt("PerpExchange", d.exchange, signer);
  const tickers = process.env.TICKERS ? process.env.TICKERS.split(",").map((t) => t.trim().toUpperCase()) : DEFAULT_TICKERS;

  const [, , , , , , , listingFee] = await exchange.risk();
  const needed = listingFee * BigInt(tickers.length);
  const balance = await exchange.balances(signer.address);
  if (balance < needed && d.faucet) {
    const token = await ethers.getContractAt("MockUSDC", d.collateral, signer);
    const scale = 10n ** (18n - BigInt(await token.decimals()));
    const amount = (needed - balance + scale - 1n) / scale;
    await (await token.mint(signer.address, amount)).wait();
    await (await token.approve(d.exchange, amount)).wait();
    await (await exchange.deposit(amount)).wait();
  }

  const listed = await listPythMarkets(exchange, tickers);
  console.log(`Listed ${listed.length} market(s): ${listed.join(", ") || "none"}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
