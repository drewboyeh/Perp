// Liquidation keeper. Anyone can run this and earn liquidation rewards.
// Tracks traders from PositionModified events and liquidates unhealthy positions.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");
const { getPythUpdateData } = require("./lib/hermes");

const { ethers } = hre;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 5000);

async function main() {
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  const exchange = await ethers.getContractAt("PerpExchange", d.exchange, signer);
  console.log(`Keeper ${signer.address} watching ${d.exchange}`);

  const open = new Set(); // `${marketId}:${trader}`
  let fromBlock = d.startBlock || 0;

  for (;;) {
    try {
      const head = await ethers.provider.getBlockNumber();
      if (head >= fromBlock) {
        const logs = await exchange.queryFilter(exchange.filters.PositionModified(), fromBlock, head);
        for (const l of logs) {
          const key = `${l.args.marketId}:${l.args.trader}`;
          if (l.args.newSize === 0n) open.delete(key);
          else open.add(key);
        }
        const liq = await exchange.queryFilter(exchange.filters.Liquidated(), fromBlock, head);
        for (const l of liq) open.delete(`${l.args.marketId}:${l.args.trader}`);
        fromBlock = head + 1;
      }

      for (const key of open) {
        const [marketId, trader] = key.split(":");
        const pos = await exchange.getPosition(marketId, trader);
        if (pos.size === 0n) {
          open.delete(key);
          continue;
        }
        if (!pos.liquidatable) continue;

        let update = [];
        let fee = 0n;
        if (d.oracleType === "pyth") {
          const m = await exchange.getMarket(marketId);
          update = await getPythUpdateData([m.feedId]);
          fee = await exchange.getOracleUpdateFee(update);
        }
        try {
          const tx = await exchange.liquidate(marketId, trader, update, { value: fee });
          const rc = await tx.wait();
          const ev = rc.logs.map((x) => exchange.interface.parseLog(x)).find((x) => x && x.name === "Liquidated");
          console.log(
            `Liquidated ${pos.symbol} ${trader} size ${ethers.formatUnits(pos.size, 18)}` +
              ` reward $${ethers.formatUnits(ev.args.reward, 18)}`,
          );
          open.delete(key);
        } catch (e) {
          console.error(`liquidate ${key} failed:`, e.shortMessage || e.message);
        }
      }
    } catch (e) {
      console.error("keeper error:", e.shortMessage || e.message);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
