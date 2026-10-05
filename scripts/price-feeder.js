// Dev price feeder for MockOracle deployments: pushes a random walk for every listed market
// (including markets users list later) so prices stay fresh and PnL moves.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");

const { ethers } = hre;
const INTERVAL_MS = Number(process.env.FEEDER_INTERVAL_MS || 4000);
const VOLATILITY = Number(process.env.FEEDER_VOLATILITY || 0.002); // per tick

function gaussian() {
  const u = 1 - Math.random();
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

async function main() {
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  if (d.oracleType !== "mock") throw new Error("price-feeder only drives MockOracle deployments");
  const exchange = await ethers.getContractAt("PerpExchange", d.exchange);
  const oracle = await ethers.getContractAt("MockOracle", d.oracle);
  console.log(`Feeding prices every ${INTERVAL_MS}ms`);

  for (;;) {
    try {
      const markets = await exchange.getMarkets();
      const feeds = [];
      const prices = [];
      for (const m of markets) {
        const last = Number(ethers.formatUnits(m.price, 18));
        if (last === 0) continue;
        const next = last * Math.exp(VOLATILITY * gaussian());
        feeds.push(m.feedId);
        prices.push(ethers.parseUnits(next.toFixed(6), 18));
      }
      if (feeds.length) {
        await (await oracle.setPrices(feeds, prices)).wait();
        const summary = markets
          .slice(0, 6)
          .map((m, i) => `${m.symbol} ${Number(ethers.formatUnits(prices[i] ?? m.price, 18)).toFixed(2)}`)
          .join("  ");
        console.log(new Date().toISOString().slice(11, 19), summary, markets.length > 6 ? "…" : "");
      }
    } catch (e) {
      console.error("feeder error:", e.shortMessage || e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
