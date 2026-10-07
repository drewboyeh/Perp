// Lists markets on a MockOracle deployment: stocks at live quotes from scripts/lib/quotes.js, and
// private-company markets (symbols ending in -PRE) at the operator's reference prices from
// scripts/lib/private-markets.js. The signer must be an oracle reporter and, for private markets,
// the exchange owner. Listing needs a fresh price; others are skipped and can be retried later.
const { ethers } = require("hardhat");
const { getQuote } = require("./quotes");
const { PRIVATE_MARKET_PARAMS, isPrivateSymbol, privatePrice } = require("./private-markets");

const mockFeedId = (ticker) => ethers.id(`MOCK:${ticker.toUpperCase()}`);
const toWad = (price) => ethers.parseUnits(price.toFixed(6), 18);
const PARAM_KEYS = Object.keys(PRIVATE_MARKET_PARAMS);

async function referencePrice(ticker) {
  if (isPrivateSymbol(ticker)) {
    const r = privatePrice(ticker, 0n);
    return r.error ? r : { price: r.price, label: `$${ethers.formatUnits(r.price, 18)} (reference)` };
  }
  const q = await getQuote(ticker);
  return q.error ? q : { price: toWad(q.price), label: `$${q.price} (${q.source})` };
}

/** Creates a market whose parameters are `params` from its first block, then restores the defaults. */
async function createWithParams(exchange, ticker, feedId, params) {
  const r = await exchange.defaultMarketParams();
  const defaults = Object.fromEntries(PARAM_KEYS.map((k) => [k, r[k]]));
  await (await exchange.setDefaultMarketParams(params)).wait();
  try {
    await (await exchange.createMarket(ticker, feedId, [])).wait();
  } finally {
    await (await exchange.setDefaultMarketParams(defaults)).wait();
  }
}

async function listQuotedMarkets(exchange, oracle, tickers, log = console.log) {
  const listed = [];
  for (const ticker of tickers) {
    const feedId = mockFeedId(ticker);
    if (await exchange.feedListed(feedId)) {
      log(`${ticker}: already listed`);
      continue;
    }
    const ref = await referencePrice(ticker);
    if (ref.error) {
      log(`${ticker}: no fresh price (${ref.error}), skipped`);
      continue;
    }
    await (await oracle.setPrice(feedId, ref.price)).wait();
    if (isPrivateSymbol(ticker)) await createWithParams(exchange, ticker, feedId, PRIVATE_MARKET_PARAMS);
    else await (await exchange.createMarket(ticker, feedId, [])).wait();
    log(`${ticker}: listed at ${ref.label}`);
    listed.push(ticker);
  }
  return listed;
}

module.exports = { mockFeedId, toWad, listQuotedMarkets };
