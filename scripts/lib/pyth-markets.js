// Lists stock markets backed by Pyth equity feeds. Listing needs a fresh price, so it only
// succeeds while the stock is trading; closed markets are skipped and can be retried later.
const { getPythUpdateData, findEquityFeed } = require("./hermes");

const DEFAULT_TICKERS = ["AAPL", "MSFT", "NVDA", "TSLA", "AMZN", "GOOGL", "META", "NFLX", "AMD", "SPY"];

async function listPythMarkets(exchange, tickers, log = console.log) {
  const listed = [];
  for (const ticker of tickers) {
    const feedId = await findEquityFeed(ticker);
    if (!feedId) {
      log(`${ticker}: no Pyth equity feed found, skipped`);
      continue;
    }
    if (await exchange.feedListed(feedId)) {
      log(`${ticker}: already listed`);
      continue;
    }
    const update = await getPythUpdateData([feedId]);
    const value = await exchange.getOracleUpdateFee(update);
    try {
      await (await exchange.createMarket(ticker, feedId, update, { value })).wait();
      log(`${ticker}: listed (${feedId})`);
      listed.push(ticker);
    } catch (e) {
      if (revertName(exchange, e) === "StalePrice") {
        log(`${ticker}: price is stale (market closed), skipped; retry during market hours`);
      } else {
        throw e;
      }
    }
  }
  return listed;
}

/** Decodes a contract revert to its custom error name. RPCs nest the revert data differently. */
function revertName(contract, e) {
  const candidates = [e.data, e.data?.data, e.info?.error?.data, e.info?.error?.data?.data, e.error?.data];
  for (const data of candidates) {
    if (typeof data !== "string" || !data.startsWith("0x")) continue;
    try {
      const err = contract.interface.parseError(data);
      if (err) return err.name;
    } catch {}
  }
  return undefined;
}

module.exports = { DEFAULT_TICKERS, listPythMarkets };
