// Price feeder for MockOracle deployments on testnets: pushes live US stock prices from free
// market-data APIs (scripts/lib/quotes.js) for every listed market, including ones listed later,
// and the operator's reference prices for private-company markets (scripts/lib/private-markets.js,
// re-read every round so edits apply without a restart).
// Run it next to the keeper. The signer must be an oracle reporter (see scripts/set-reporter.js).
//
//   FEEDER_INTERVAL_MS  push interval (default 20000; stretched to respect Finnhub's 60/min limit)
//   FEEDER_HOURS        "regular" (default): push only 9:30-16:00 New York time, Mon-Fri.
//                       "any": push whenever a source has a fresh quote, including extended hours.
//   FEEDER_MAX_JUMP     skip a quote that moves more than this fraction from a still-fresh
//                       on-chain price (default 0.15). Once the old price goes stale it is accepted.
const hre = require("hardhat");
const { readDeployment } = require("./lib/deployments");
const { getQuote, usMarketOpen, sourcesFor } = require("./lib/quotes");
const { toWad } = require("./lib/quote-markets");
const { isPrivateSymbol, privatePrice } = require("./lib/private-markets");

const { ethers } = hre;
const INTERVAL_MS = Number(process.env.FEEDER_INTERVAL_MS || 20_000);
const HOURS = process.env.FEEDER_HOURS || "regular";
const MAX_JUMP = Number(process.env.FEEDER_MAX_JUMP || 0.15);
const MS_PER_FINNHUB_CALL = 1100; // stays under 60 requests/minute

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [signer] = await ethers.getSigners();
  const { chainId } = await ethers.provider.getNetwork();
  const d = readDeployment(chainId);
  if (d.oracleType !== "mock") throw new Error("stock-feeder drives MockOracle deployments only");
  if (!["regular", "any"].includes(HOURS)) throw new Error('FEEDER_HOURS must be "regular" or "any"');
  const exchange = await ethers.getContractAt("PerpExchange", d.exchange, signer);
  const oracle = await ethers.getContractAt("MockOracle", d.oracle, signer);
  if (!(await oracle.isReporter(signer.address))) {
    throw new Error(`${signer.address} is not an oracle reporter; have the owner run scripts/set-reporter.js`);
  }
  sourcesFor("AAPL"); // fail fast on missing keys
  console.log(`Feeder ${signer.address} pushing live prices to ${d.oracle} every ${INTERVAL_MS / 1000}s`);

  const lastStatus = new Map(); // ticker -> last logged problem, so repeats don't spam
  const report = (ticker, problem) => {
    if (lastStatus.get(ticker) !== problem) {
      if (problem) console.log(`${ticker}: ${problem}`);
      else if (lastStatus.get(ticker)) console.log(`${ticker}: back to live prices`);
    }
    lastStatus.set(ticker, problem);
  };

  let closedLogged = false;
  for (;;) {
    const started = Date.now();
    let wait = INTERVAL_MS;
    try {
      if (HOURS === "regular" && !usMarketOpen()) {
        if (!closedLogged) console.log("US market closed; waiting for the open");
        closedLogged = true;
        await sleep(60_000);
        continue;
      }
      closedLogged = false;

      const markets = await exchange.getMarkets();
      const stockCount = markets.filter((m) => !isPrivateSymbol(m.symbol)).length;
      wait = Math.max(INTERVAL_MS, stockCount * MS_PER_FINNHUB_CALL);
      const feeds = [];
      const prices = [];
      const summary = [];
      for (const m of markets) {
        if (isPrivateSymbol(m.symbol)) {
          const r = privatePrice(m.symbol, m.price);
          report(m.symbol, r.error);
          if (r.error) continue;
          feeds.push(m.feedId);
          prices.push(r.price);
          summary.push(`${m.symbol} ${ethers.formatUnits(r.price, 18)}`);
          continue;
        }
        const q = await getQuote(m.symbol);
        if (q.error) {
          report(m.symbol, `no fresh quote (${q.error})`);
          continue;
        }
        const next = toWad(q.price);
        if (m.priceFresh && m.price > 0n) {
          const jump = Math.abs(Number((next * 1_000_000n) / m.price) / 1_000_000 - 1);
          if (jump > MAX_JUMP) {
            report(m.symbol, `quote $${q.price} is ${(jump * 100).toFixed(1)}% off the on-chain price; holding`);
            continue;
          }
        }
        report(m.symbol, undefined);
        feeds.push(m.feedId);
        prices.push(next);
        summary.push(`${m.symbol} ${q.price}`);
      }
      if (feeds.length) {
        await (await oracle.setPrices(feeds, prices)).wait();
        console.log(new Date().toISOString().slice(11, 19), summary.join("  "));
      }
    } catch (e) {
      console.error("feeder error:", e.shortMessage || e.message);
    }
    await sleep(Math.max(0, wait - (Date.now() - started)));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
