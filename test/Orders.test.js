const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { usd, usdc, feed, deployFixture, refreshPrice, execute, trade, close, expectFail } = require("./helpers");

const AAPL = 0;
const KEEPER_FEE = usd(1);

async function ordersFixture() {
  const f = await deployFixture();
  await f.exchange.connect(f.owner).setOrderConfig({ minDelay: 2n, maxDelay: 60n, keeperFee: KEEPER_FEE });
  await f.exchange.connect(f.alice).deposit(usdc(1000));
  const keeper = (await ethers.getSigners())[6];
  return { ...f, keeper };
}

describe("Delayed orders", function () {
  it("escrows margin and keeper fee at commit and pays the fee to the executor", async function () {
    const { exchange, alice, keeper } = await loadFixture(ordersFixture);
    await expect(exchange.connect(alice).commitOrder(AAPL, usd(5), usd(200), ethers.MaxUint256, false))
      .to.emit(exchange, "OrderCommitted")
      .withArgs(AAPL, alice.address, usd(5), usd(200), ethers.MaxUint256, false, KEEPER_FEE);
    expect(await exchange.balances(alice.address)).to.equal(usd(799));
    expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);

    const views = await exchange.getOrders(alice.address);
    expect(views.length).to.equal(1);
    expect(views[0].symbol).to.equal("AAPL");
    expect(views[0].expiresAt - views[0].executableAt).to.equal(58n);

    await expect(execute(exchange, alice.address, AAPL)).to.not.be.rejected;
    expect((await exchange.positions(AAPL, alice.address)).size).to.equal(usd(5));
    expect(await exchange.balances(keeper.address)).to.equal(KEEPER_FEE);
    expect(await exchange.balances(alice.address)).to.equal(usd(799));
    expect((await exchange.orders(AAPL, alice.address)).commitTime).to.equal(0);
  });

  it("only executes at a price published after the commit delay", async function () {
    const { exchange, oracle, alice, keeper } = await loadFixture(ordersFixture);
    await refreshPrice(exchange, AAPL);
    await exchange.connect(alice).commitOrder(AAPL, usd(5), usd(200), ethers.MaxUint256, false);

    // Too early.
    await expect(exchange.connect(keeper).executeOrder(AAPL, alice.address, [])).to.be.revertedWithCustomError(
      exchange,
      "OrderNotReady",
    );
    // Delay passed, but the only price on-chain is one the trader could see when committing.
    await time.increase(2);
    await expect(exchange.connect(keeper).executeOrder(AAPL, alice.address, [])).to.be.revertedWithCustomError(
      exchange,
      "PriceNotAfterCommit",
    );
    // A new price arrives (the market moved): the order fills at it, not at the commit-time price.
    await oracle.setPrice(feed("AAPL"), usd(210));
    await exchange.connect(keeper).executeOrder(AAPL, alice.address, []);
    expect((await exchange.positions(AAPL, alice.address)).entryPrice).to.be.closeTo(usd(210), usd("0.01"));
  });

  it("allows one pending order per market", async function () {
    const { exchange, alice } = await loadFixture(ordersFixture);
    await exchange.connect(alice).commitOrder(AAPL, usd(1), usd(100), ethers.MaxUint256, false);
    await expect(
      exchange.connect(alice).commitOrder(AAPL, usd(1), usd(100), ethers.MaxUint256, false),
    ).to.be.revertedWithCustomError(exchange, "OrderPending");
  });

  it("cancels invalid orders at execution, refunding escrow but paying the keeper", async function () {
    const { exchange, oracle, alice, keeper } = await loadFixture(ordersFixture);
    await exchange.connect(alice).commitOrder(AAPL, usd(1), usd(100), usd(201), false);
    await time.increase(2);
    await oracle.setPrice(feed("AAPL"), usd(205)); // price ran away: worse than acceptable

    const rc = await (await exchange.connect(keeper).executeOrder(AAPL, alice.address, [])).wait();
    const ev = rc.logs.map((l) => exchange.interface.parseLog(l)).find((l) => l?.name === "OrderCancelled");
    expect(exchange.interface.parseError(ev.args.reason).name).to.equal("SlippageExceeded");
    expect(await exchange.balances(alice.address)).to.equal(usd(999));
    expect(await exchange.balances(keeper.address)).to.equal(KEEPER_FEE);
    expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);
  });

  it("can't be cancelled before expiry, and expired orders can't execute", async function () {
    const { exchange, alice, bob } = await loadFixture(ordersFixture);
    await exchange.connect(alice).commitOrder(AAPL, usd(1), usd(100), ethers.MaxUint256, false);
    await expect(exchange.connect(alice).cancelOrder(AAPL, alice.address)).to.be.revertedWithCustomError(
      exchange,
      "OrderNotExpired",
    );
    await time.increase(61);
    await refreshPrice(exchange, AAPL);
    await expect(exchange.connect(bob).executeOrder(AAPL, alice.address, [])).to.be.revertedWithCustomError(
      exchange,
      "OrderExpired",
    );
    await exchange.connect(bob).cancelOrder(AAPL, alice.address);
    expect(await exchange.balances(alice.address)).to.equal(usd(999));
    expect(await exchange.balances(bob.address)).to.equal(KEEPER_FEE);
  });

  it("refunds the keeper fee when traders cancel their own expired order", async function () {
    const { exchange, alice } = await loadFixture(ordersFixture);
    await exchange.connect(alice).commitOrder(AAPL, usd(1), usd(100), ethers.MaxUint256, false);
    await time.increase(61);
    await exchange.connect(alice).cancelOrder(AAPL, alice.address);
    expect(await exchange.balances(alice.address)).to.equal(usd(1000));
  });

  it("clamps reduce-only orders and never lets them open a new position", async function () {
    const { exchange, oracle, alice, liquidator } = await loadFixture(ordersFixture);
    await trade(exchange, alice, AAPL, usd(5), usd(200));
    // Reduce-only sell larger than the position just closes it.
    await trade(exchange, alice, AAPL, -usd(50), 0n, { reduceOnly: true });
    expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);

    // A pending close whose position gets liquidated first is cancelled, not flipped short.
    await trade(exchange, alice, AAPL, usd(90), usd(950));
    await exchange.connect(alice).commitOrder(AAPL, -usd(90), 0n, 0n, true);
    await oracle.setPrice(feed("AAPL"), usd(185));
    await exchange.connect(liquidator).liquidate(AAPL, alice.address, []);
    await expectFail(execute(exchange, alice.address, AAPL), "NothingToReduce");
    expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);
  });

  it("adds margin instantly, even while paused", async function () {
    const { exchange, owner, alice } = await loadFixture(ordersFixture);
    await trade(exchange, alice, AAPL, usd(5), usd(100));
    await exchange.connect(owner).pause();
    const before = (await exchange.positions(AAPL, alice.address)).margin;
    await exchange.connect(alice).addMargin(AAPL, usd(50), []);
    // also settles a few seconds of accrued funding
    expect((await exchange.positions(AAPL, alice.address)).margin).to.be.closeTo(before + usd(50), usd("0.001"));
    await expect(exchange.connect(alice).addMargin(1, usd(50), [])).to.be.revertedWithCustomError(
      exchange,
      "NoPosition",
    );
    await close(exchange, alice, AAPL); // exits still work while paused
  });

  it("protects the internal execution entry point", async function () {
    const { exchange, alice } = await loadFixture(ordersFixture);
    const order = { sizeDelta: usd(1), marginDelta: usd(100), acceptablePrice: 0n, keeperFee: 0n, commitTime: 1n, reduceOnly: false };
    await expect(exchange.connect(alice).selfExecuteOrder(AAPL, alice.address, order)).to.be.revertedWithCustomError(
      exchange,
      "OnlySelf",
    );
  });

  it("validates order config", async function () {
    const { exchange, owner } = await loadFixture(ordersFixture);
    await expect(
      exchange.connect(owner).setOrderConfig({ minDelay: 10n, maxDelay: 10n, keeperFee: 0n }),
    ).to.be.revertedWithCustomError(exchange, "InvalidParams");
    await expect(
      exchange.connect(owner).setOrderConfig({ minDelay: 1n, maxDelay: 7200n, keeperFee: 0n }),
    ).to.be.revertedWithCustomError(exchange, "InvalidParams");
  });
});
