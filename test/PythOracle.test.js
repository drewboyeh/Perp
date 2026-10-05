const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { usd, usdc, DEFAULT_RISK, DEFAULT_PARAMS } = require("./helpers");

// Pyth's real feed id format; any bytes32 works against MockPyth.
const AAPL_FEED = ethers.id("Equity.US.AAPL/USD");
const UPDATE_FEE = ethers.parseUnits("1", "gwei");

describe("PythOracle integration", function () {
  async function setup() {
    const [owner, alice] = await ethers.getSigners();
    const pyth = await ethers.deployContract("MockPyth", [60, UPDATE_FEE]);
    const adapter = await ethers.deployContract("PythOracle", [await pyth.getAddress()]);
    const token = await ethers.deployContract("MockUSDC");
    const exchange = await ethers.deployContract("PerpExchange", [
      await token.getAddress(),
      await adapter.getAddress(),
      { ...DEFAULT_RISK, listingFee: 0n },
      DEFAULT_PARAMS,
    ]);
    for (const s of [owner, alice]) {
      await token.mint(s.address, usdc(2_000_000));
      await token.connect(s).approve(await exchange.getAddress(), ethers.MaxUint256);
    }
    await exchange.addLiquidity(usdc(1_000_000), 0, []);

    // Pyth equities use expo -5; 20012345 * 1e-5 = $200.12345
    const update = async (price, conf = 1000n) => {
      const now = BigInt(await time.latest()) + 1n;
      return [await pyth.createPriceFeedUpdateData(AAPL_FEED, price, conf, -5, price, conf, now, now - 1n)];
    };
    return { owner, alice, pyth, adapter, exchange, update };
  }

  it("normalizes Pyth prices to 18 decimals", async function () {
    const { pyth, adapter, update } = await setup();
    await pyth.updatePriceFeeds(await update(20012345n), { value: UPDATE_FEE });
    const [price, conf] = await adapter.getPrice(AAPL_FEED);
    expect(price).to.equal(usd("200.12345"));
    expect(conf).to.equal(usd("0.01"));
  });

  it("lists and trades with in-transaction price updates, refunding excess fee", async function () {
    const { alice, exchange, update } = await setup();
    await exchange.connect(alice).deposit(usdc(1000));

    const data = await update(20000000n);
    expect(await exchange.getOracleUpdateFee(data)).to.equal(UPDATE_FEE);

    const before = await ethers.provider.getBalance(alice.address);
    const tx = await exchange.connect(alice).createMarket("AAPL", AAPL_FEED, data, { value: UPDATE_FEE * 10n });
    const rc = await tx.wait();
    const spent = before - (await ethers.provider.getBalance(alice.address));
    expect(spent).to.equal(rc.gasUsed * rc.gasPrice + UPDATE_FEE);

    await exchange
      .connect(alice)
      .modifyPosition(0, usd(5), usd(200), ethers.MaxUint256, await update(20100000n), { value: UPDATE_FEE });
    const pos = await exchange.getPosition(0, alice.address);
    expect(pos.size).to.equal(usd(5));
    expect(pos.entryPrice).to.be.closeTo(usd(201), usd("0.01"));
  });

  it("requires the update fee and rejects low-confidence prices", async function () {
    const { alice, exchange, update } = await setup();
    await exchange.connect(alice).deposit(usdc(1000));
    await expect(
      exchange.connect(alice).createMarket("AAPL", AAPL_FEED, await update(20000000n)),
    ).to.be.revertedWithCustomError(exchange, "InsufficientOracleFee");
    // conf $10 on $200 = 5% > 2% limit
    await expect(
      exchange.connect(alice).createMarket("AAPL", AAPL_FEED, await update(20000000n, 1000000n), {
        value: UPDATE_FEE,
      }),
    ).to.be.revertedWithCustomError(exchange, "PriceUncertain");
  });
});
