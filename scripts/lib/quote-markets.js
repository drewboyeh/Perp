// Lists stock markets on a MockOracle deployment at live prices from scripts/lib/quotes.js.
// The signer must be an oracle reporter (the deployer is). Listing needs a fresh quote, so it only
// succeeds while the stock trades; others are skipped and can be retried later.
const { ethers } = require("hardhat");
const { getQuote } = require("./quotes");

const mockFeedId = (ticker) => ethers.id(`MOCK:${ticker.toUpperCase()}`);
const toWad = (price) => ethers.parseUnits(price.toFixed(6), 18);

async function listQuotedMarkets(exchange, oracle, tickers, log = console.log) {
  const listed = [];
  for (const ticker of tickers) {
    const feedId = mockFeedId(ticker);
    if (await exchange.feedListed(feedId)) {
      log(`${ticker}: already listed`);
      continue;
    }
    const q = await getQuote(ticker);
    if (q.error) {
      log(`${ticker}: no fresh quote (${q.error}), skipped; retry during market hours`);
      continue;
    }
    await (await oracle.setPrice(feedId, toWad(q.price))).wait();
    await (await exchange.createMarket(ticker, feedId, [])).wait();
    log(`${ticker}: listed at $${q.price} (${q.source})`);
    listed.push(ticker);
  }
  return listed;
}

module.exports = { mockFeedId, toWad, listQuotedMarkets };
