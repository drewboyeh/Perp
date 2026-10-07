const fs = require("fs");
const os = require("os");
const path = require("path");
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { usd, DEFAULT_PARAMS, deployFixture } = require("./helpers");
const { PRIVATE_MARKET_PARAMS, privatePrice } = require("../scripts/lib/private-markets");
const { listQuotedMarkets, mockFeedId } = require("../scripts/lib/quote-markets");

const DAY = 86_400_000;
const today = new Date().toISOString().slice(0, 10);

describe("Private-company markets", function () {
  let dir;
  const writeMarkets = (markets) => fs.writeFileSync(process.env.PRIVATE_MARKETS_FILE, JSON.stringify({ markets }));

  beforeEach(function () {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "private-markets-"));
    process.env.PRIVATE_MARKETS_FILE = path.join(dir, "private-markets.json");
  });
  afterEach(function () {
    delete process.env.PRIVATE_MARKETS_FILE;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe("reference prices", function () {
    it("holds markets without a usable price", function () {
      expect(privatePrice("OPENAI-PRE", 0n).error).to.match(/not in/);
      writeMarkets({ "OPENAI-PRE": { price: null, asOf: null } });
      expect(privatePrice("OPENAI-PRE", 0n).error).to.equal("no reference price set");
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: "soon" } });
      expect(privatePrice("OPENAI-PRE", 0n).error).to.match(/invalid asOf/);
    });

    it("stops pushing stale or future-dated prices", function () {
      const now = Date.parse(`${today}T12:00:00Z`);
      const iso = (t) => new Date(t).toISOString().slice(0, 10);
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: iso(now - 5 * DAY) } });
      expect(privatePrice("OPENAI-PRE", 0n, now).error).to.match(/days old/);
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: iso(now + 3 * DAY) } });
      expect(privatePrice("OPENAI-PRE", 0n, now).error).to.match(/in the future/);
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: iso(now - 2 * DAY) } });
      expect(privatePrice("OPENAI-PRE", 0n, now).price).to.equal(usd(500));
    });

    it("holds a large move until the operator confirms it", function () {
      writeMarkets({ "OPENAI-PRE": { price: 650, asOf: today } });
      expect(privatePrice("OPENAI-PRE", usd(500)).error).to.match(/30\.0% .*confirmPrice": 650/);
      writeMarkets({ "OPENAI-PRE": { price: 650, asOf: today, confirmPrice: 600 } });
      expect(privatePrice("OPENAI-PRE", usd(500)).error).to.match(/held/); // a stale confirmation doesn't count
      writeMarkets({ "OPENAI-PRE": { price: 650, asOf: today, confirmPrice: 650 } });
      expect(privatePrice("OPENAI-PRE", usd(500)).price).to.equal(usd(650));
      writeMarkets({ "OPENAI-PRE": { price: 540, asOf: today } });
      expect(privatePrice("OPENAI-PRE", usd(500)).price).to.equal(usd(540)); // 8% passes
    });

    it("rejects symbols without the -PRE suffix", function () {
      writeMarkets({ OPENAI: { price: 500, asOf: today } });
      expect(() => privatePrice("OPENAI-PRE", 0n)).to.throw(/must end with -PRE/);
    });
  });

  describe("listing", function () {
    it("lists with conservative parameters from the first block and restores the defaults", async function () {
      const { exchange, oracle } = await loadFixture(deployFixture);
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: today }, "STRIPE-PRE": { price: null, asOf: null } });
      const logs = [];
      const listed = await listQuotedMarkets(exchange, oracle, ["OPENAI-PRE", "STRIPE-PRE"], (l) => logs.push(l));

      expect(listed).to.deep.equal(["OPENAI-PRE"]);
      expect(logs[1]).to.match(/STRIPE-PRE: no fresh price \(no reference price set\)/);
      const m = await exchange.getMarketView(1);
      expect(m.symbol).to.equal("OPENAI-PRE");
      expect(m.feedId).to.equal(mockFeedId("OPENAI-PRE"));
      expect(m.price).to.equal(usd(500));
      for (const k of Object.keys(PRIVATE_MARKET_PARAMS)) expect(m.params[k]).to.equal(PRIVATE_MARKET_PARAMS[k]);
      const defaults = await exchange.defaultMarketParams();
      for (const k of Object.keys(DEFAULT_PARAMS)) expect(defaults[k]).to.equal(DEFAULT_PARAMS[k]);
    });

    it("restores the defaults when listing fails", async function () {
      const { exchange, oracle, owner } = await loadFixture(deployFixture);
      await exchange.connect(owner).withdraw(await exchange.balances(owner.address) / 10n ** 12n); // no listing fee
      writeMarkets({ "OPENAI-PRE": { price: 500, asOf: today } });
      await expect(listQuotedMarkets(exchange, oracle, ["OPENAI-PRE"], () => {})).to.be.rejectedWith(
        /InsufficientBalance/,
      );
      const defaults = await exchange.defaultMarketParams();
      expect(defaults.maxLeverage).to.equal(DEFAULT_PARAMS.maxLeverage);
      expect(await exchange.marketCount()).to.equal(1n);
    });
  });
});
