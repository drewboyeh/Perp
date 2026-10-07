// Private-company ("pre-IPO") markets on MockOracle deployments: synthetic perps on a reference
// price for companies like OpenAI or Stripe. Nobody trades the actual shares.
//
// Reference prices come from a local JSON file that the operator updates (PRIVATE_MARKETS_FILE,
// default ./private-markets.json; see private-markets.example.json). Keep it out of git: anyone who
// can read a new price before it reaches the chain can trade against the vault.
//
// Safety rules, because these prices update rarely and can gap on a funding round:
//  - Markets list with conservative parameters (low leverage, small OI caps, higher fees).
//  - A price older than PRIVATE_MAX_AGE_DAYS (default 3) stops being pushed, so trading pauses.
//  - A price that moves more than PRIVATE_MAX_JUMP (default 0.2) from the on-chain price is held,
//    pausing the market, until the operator confirms it by setting "confirmPrice" to the same value.
const fs = require("fs");
const path = require("path");
const { ethers } = require("hardhat");

const usd = (n) => ethers.parseUnits(String(n), 18);

/** On-chain symbols of private markets end with this suffix, e.g. OPENAI-PRE. */
const PRIVATE_SUFFIX = "-PRE";

const PRIVATE_MARKET_PARAMS = {
  maxLeverage: usd(3),
  maintenanceMargin: usd("0.1"),
  takerFee: usd("0.003"),
  maxOpenInterest: usd(250_000),
  skewScale: usd(50_000_000),
  maxFundingRate: usd("0.003"),
};

const isPrivateSymbol = (symbol) => symbol.toUpperCase().endsWith(PRIVATE_SUFFIX);

function privateMarketsFile() {
  return path.resolve(process.env.PRIVATE_MARKETS_FILE || "private-markets.json");
}

/** The operator's reference prices: { [symbol]: { name, price, asOf, source, confirmPrice } }. */
function loadPrivateMarkets() {
  const file = privateMarketsFile();
  if (!fs.existsSync(file)) return {};
  const { markets = {} } = JSON.parse(fs.readFileSync(file, "utf8"));
  for (const symbol of Object.keys(markets)) {
    if (!isPrivateSymbol(symbol)) throw new Error(`${file}: private market "${symbol}" must end with ${PRIVATE_SUFFIX}`);
    if (symbol.length > 16) throw new Error(`${file}: symbol "${symbol}" is longer than 16 characters`);
  }
  return markets;
}

/**
 * Decides what to push for a private market. `onchainPrice` is the market's current on-chain price
 * (WAD, 0 if none). Returns `{ price }` (WAD) or `{ error }` explaining why the market is held.
 */
function privatePrice(symbol, onchainPrice, now = Date.now()) {
  const entry = loadPrivateMarkets()[symbol.toUpperCase()];
  if (!entry) return { error: `not in ${path.basename(privateMarketsFile())}` };
  if (!(entry.price > 0)) return { error: "no reference price set" };
  const asOf = Date.parse(entry.asOf);
  if (Number.isNaN(asOf)) return { error: `invalid asOf date "${entry.asOf}"` };
  const maxAgeDays = Number(process.env.PRIVATE_MAX_AGE_DAYS || 3);
  const ageDays = (now - asOf) / 86_400_000;
  if (ageDays > maxAgeDays) return { error: `reference price is ${ageDays.toFixed(1)} days old` };
  if (ageDays < -1) return { error: `asOf ${entry.asOf} is in the future` };

  const price = ethers.parseUnits(Number(entry.price).toFixed(6), 18);
  if (onchainPrice > 0n && price !== onchainPrice && entry.confirmPrice !== entry.price) {
    const maxJump = Number(process.env.PRIVATE_MAX_JUMP || 0.2);
    const jump = Math.abs(Number((price * 1_000_000n) / onchainPrice) / 1_000_000 - 1);
    if (jump > maxJump) {
      return {
        error: `new price ${entry.price} moves ${(jump * 100).toFixed(1)}% from the on-chain price; held until "confirmPrice": ${entry.price}`,
      };
    }
  }
  return { price };
}

module.exports = { PRIVATE_SUFFIX, PRIVATE_MARKET_PARAMS, isPrivateSymbol, loadPrivateMarkets, privatePrice };
