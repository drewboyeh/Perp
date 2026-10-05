// Keeper bot. Anyone can run this and earn keeper fees and liquidation rewards.
//  - Executes committed orders once their delay has passed and a newer oracle price exists.
//  - Cancels orders that expired unexecuted.
//  - Liquidates positions below maintenance margin.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");
const { getPythUpdateData } = require("./lib/hermes");

const { ethers } = hre;
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS || 1000);

async function main() {
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  const exchange = await ethers.getContractAt("PerpExchange", d.exchange, signer);
  const oracle = await ethers.getContractAt("IPriceOracle", d.oracle);
  console.log(`Keeper ${signer.address} watching ${d.exchange}`);

  const positions = new Set(); // `${marketId}:${trader}` with open positions
  const orders = new Map(); // `${marketId}:${trader}` -> commitTime
  const feedOf = new Map(); // marketId -> feedId
  let fromBlock = d.startBlock || 0;

  const feed = async (marketId) => {
    if (!feedOf.has(marketId)) feedOf.set(marketId, (await exchange.getMarket(marketId)).feedId);
    return feedOf.get(marketId);
  };
  const priceUpdate = async (marketId) => {
    if (d.oracleType !== "pyth") return { update: [], value: 0n };
    const update = await getPythUpdateData([await feed(marketId)]);
    return { update, value: await exchange.getOracleUpdateFee(update) };
  };
  const send = async (label, fn) => {
    try {
      const rc = await (await fn()).wait();
      return rc;
    } catch (e) {
      console.error(`${label} failed:`, e.shortMessage || e.message);
    }
  };

  async function syncEvents() {
    const head = await ethers.provider.getBlockNumber();
    if (head < fromBlock) return;
    const [modified, liquidated, committed, executed, cancelled] = await Promise.all(
      ["PositionModified", "Liquidated", "OrderCommitted", "OrderExecuted", "OrderCancelled"].map((name) =>
        exchange.queryFilter(exchange.filters[name](), fromBlock, head),
      ),
    );
    // Apply in chain order so commit -> execute within one batch resolves correctly.
    const all = [...modified, ...liquidated, ...committed, ...executed, ...cancelled].sort(
      (a, b) => a.blockNumber - b.blockNumber || a.index - b.index,
    );
    for (const l of all) {
      const key = `${l.args.marketId}:${l.args.trader}`;
      switch (l.fragment.name) {
        case "PositionModified":
          if (l.args.newSize === 0n) positions.delete(key);
          else positions.add(key);
          break;
        case "Liquidated":
          positions.delete(key);
          break;
        case "OrderCommitted":
          orders.set(key, BigInt((await l.getBlock()).timestamp));
          break;
        default:
          orders.delete(key);
      }
    }
    fromBlock = head + 1;
  }

  async function processOrders() {
    if (orders.size === 0) return;
    const { minDelay, maxDelay } = await exchange.orderConfig();
    const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
    for (const [key, commitTime] of orders) {
      const [marketId, trader] = key.split(":");
      if (now > commitTime + maxDelay) {
        if (await send(`cancel ${key}`, () => exchange.cancelOrder(marketId, trader))) {
          console.log(`Cancelled expired order ${key}`);
          orders.delete(key);
        }
        continue;
      }
      if (now < commitTime + minDelay) continue;
      if (d.oracleType !== "pyth") {
        // Push oracle: wait until a price newer than the commit delay has been published.
        const [, , publishTime] = await oracle.getPrice(await feed(marketId));
        if (publishTime < commitTime + minDelay) continue;
      }
      const { update, value } = await priceUpdate(marketId);
      const rc = await send(`execute ${key}`, () => exchange.executeOrder(marketId, trader, update, { value }));
      if (!rc) continue;
      orders.delete(key);
      const ev = rc.logs.map((x) => exchange.interface.parseLog(x)).find((x) => x?.name.startsWith("Order"));
      if (ev?.name === "OrderCancelled") {
        const err = exchange.interface.parseError(ev.args.reason);
        console.log(`Order ${key} rejected: ${err ? err.name : ev.args.reason}`);
      } else {
        console.log(`Executed order ${key}`);
      }
    }
  }

  async function processLiquidations() {
    for (const key of positions) {
      const [marketId, trader] = key.split(":");
      const pos = await exchange.getPosition(marketId, trader);
      if (pos.size === 0n) {
        positions.delete(key);
        continue;
      }
      if (!pos.liquidatable) continue;
      const { update, value } = await priceUpdate(marketId);
      const rc = await send(`liquidate ${key}`, () => exchange.liquidate(marketId, trader, update, { value }));
      if (!rc) continue;
      const ev = rc.logs.map((x) => exchange.interface.parseLog(x)).find((x) => x?.name === "Liquidated");
      console.log(
        `Liquidated ${pos.symbol} ${trader} size ${ethers.formatUnits(pos.size, 18)}` +
          ` reward $${ethers.formatUnits(ev.args.reward, 18)}`,
      );
      positions.delete(key);
    }
  }

  for (;;) {
    try {
      await syncEvents();
      await processOrders();
      await processLiquidations();
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
