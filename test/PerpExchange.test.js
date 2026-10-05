const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { WAD, usd, usdc, feed, DEFAULT_PARAMS, deployFixture, trade } = require("./helpers");

const AAPL = 0;

function eventArgs(receipt, contract, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed && parsed.name === name) return parsed.args;
    } catch {}
  }
  throw new Error(`event ${name} not found`);
}

describe("PerpExchange", function () {
  describe("accounts", function () {
    it("scales 6-decimal deposits to 18-decimal balances and back", async function () {
      const { exchange, usdcToken, alice } = await loadFixture(deployFixture);
      const before = await usdcToken.balanceOf(alice.address);
      await exchange.connect(alice).deposit(usdc(1234.5));
      expect(await exchange.balances(alice.address)).to.equal(usd(1234.5));
      await exchange.connect(alice).withdraw(usdc(234.5));
      expect(await exchange.balances(alice.address)).to.equal(usd(1000));
      expect(await usdcToken.balanceOf(alice.address)).to.equal(before - usdc(1000));
      await expect(exchange.connect(alice).withdraw(usdc(1001))).to.be.revertedWithCustomError(
        exchange,
        "InsufficientBalance",
      );
    });
  });

  describe("market listing", function () {
    it("lets anyone list a stock with a live feed, paying the listing fee to the vault", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(500));
      const vaultBefore = await exchange.vaultBalance();
      await expect(exchange.connect(alice).createMarket("TSLA", feed("TSLA"), []))
        .to.emit(exchange, "MarketCreated")
        .withArgs(1, "TSLA", feed("TSLA"), alice.address);
      expect(await exchange.vaultBalance()).to.equal(vaultBefore + usd(100));
      expect(await exchange.balances(alice.address)).to.equal(usd(400));
      const m = await exchange.getMarketView(1);
      expect(m.symbol).to.equal("TSLA");
      expect(m.price).to.equal(usd(250));
      expect(m.params.maxLeverage).to.equal(DEFAULT_PARAMS.maxLeverage);
    });

    it("rejects duplicate feeds, feeds without prices, and stale feeds", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await expect(exchange.connect(alice).createMarket("AAPL2", feed("AAPL"), [])).to.be.revertedWithCustomError(
        exchange,
        "FeedAlreadyListed",
      );
      await expect(exchange.connect(alice).createMarket("NOPE", feed("NOPE"), [])).to.be.revertedWithCustomError(
        oracle,
        "NoPrice",
      );
      await time.increase(120);
      await expect(exchange.connect(alice).createMarket("TSLA", feed("TSLA"), [])).to.be.revertedWithCustomError(
        exchange,
        "StalePrice",
      );
      await expect(exchange.connect(alice).createMarket("", feed("X"), [])).to.be.revertedWithCustomError(
        exchange,
        "InvalidSymbol",
      );
    });
  });

  describe("trading", function () {
    it("opens a leveraged long and realizes profit on close", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      const size = usd(10); // 10 shares @ $200 = $2000 notional, 4x on $500

      const quote = await exchange.quoteFillPrice(AAPL, size);
      const openRc = await (await trade(exchange, alice, AAPL, size, usd(500))).wait();
      const open = eventArgs(openRc, exchange, "PositionModified");
      expect(open.fillPrice).to.equal(quote);
      expect(open.fee).to.equal((size * quote) / WAD / 1000n);
      expect(await exchange.balances(alice.address)).to.equal(usd(500));

      await oracle.setPrice(feed("AAPL"), usd(220));
      const pos = await exchange.getPosition(AAPL, alice.address);
      expect(pos.unrealizedPnl).to.be.closeTo(usd(200), usd("0.01"));

      const closeRc = await (await exchange.connect(alice).closePosition(AAPL, 0, [])).wait();
      const close = eventArgs(closeRc, exchange, "PositionModified");
      expect(close.newSize).to.equal(0);
      expect(close.realizedPnl).to.equal((size * (close.fillPrice - open.fillPrice)) / WAD);

      const expected = usd(1000) - open.fee - close.fee + close.realizedPnl - close.fundingPaid;
      expect(await exchange.balances(alice.address)).to.equal(expected);
      expect(expected).to.be.closeTo(usd(1195.8), usd("0.1"));
      expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);
    });

    it("realizes losses on a short when the price rises", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await trade(exchange, alice, AAPL, -usd(10), usd(500));
      await oracle.setPrice(feed("AAPL"), usd(210));
      const rc = await (await exchange.connect(alice).closePosition(AAPL, ethers.MaxUint256, [])).wait();
      const close = eventArgs(rc, exchange, "PositionModified");
      expect(close.realizedPnl).to.be.closeTo(-usd(100), usd("0.01"));
      expect(await exchange.balances(alice.address)).to.be.closeTo(usd(1000 - 100 - 4.1), usd("0.1"));
    });

    it("enforces max leverage", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      // $100 margin, $2100 notional = 21x
      await expect(trade(exchange, alice, AAPL, usd("10.5"), usd(100))).to.be.revertedWithCustomError(
        exchange,
        "InsufficientMargin",
      );
      // ~18x is fine
      await trade(exchange, alice, AAPL, usd(9), usd(100));
      const pos = await exchange.getPosition(AAPL, alice.address);
      expect(pos.leverage).to.be.closeTo(usd(18.2), usd("0.2"));
    });

    it("rejects fills worse than the acceptable price", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await expect(
        exchange.connect(alice).modifyPosition(AAPL, usd(1), usd(100), usd(200), []),
      ).to.be.revertedWithCustomError(exchange, "SlippageExceeded");
      await expect(
        exchange.connect(alice).modifyPosition(AAPL, -usd(1), usd(100), usd(201), []),
      ).to.be.revertedWithCustomError(exchange, "SlippageExceeded");
    });

    it("averages entry on increase, keeps it on reduce, and resets it on flip", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(10_000));
      await trade(exchange, alice, AAPL, usd(10), usd(1000));
      const e1 = (await exchange.positions(AAPL, alice.address)).entryPrice;

      await oracle.setPrice(feed("AAPL"), usd(300));
      await trade(exchange, alice, AAPL, usd(10), 0n);
      const e2 = (await exchange.positions(AAPL, alice.address)).entryPrice;
      expect(e2).to.be.closeTo(usd(250), usd("0.01"));
      expect(e2).to.be.gt(e1);

      await trade(exchange, alice, AAPL, -usd(5), 0n);
      expect((await exchange.positions(AAPL, alice.address)).entryPrice).to.equal(e2);
      expect((await exchange.positions(AAPL, alice.address)).size).to.equal(usd(15));

      const rc = await (await trade(exchange, alice, AAPL, -usd(20), 0n)).wait();
      const ev = eventArgs(rc, exchange, "PositionModified");
      const pos = await exchange.positions(AAPL, alice.address);
      expect(pos.size).to.equal(-usd(5));
      expect(pos.entryPrice).to.equal(ev.fillPrice);
      // closed 15 long @ ~250 entry at ~300 => ~$750 realized
      expect(ev.realizedPnl).to.be.closeTo(usd(750), usd("0.1"));
    });

    it("moves margin in and out of a position with health checks", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await trade(exchange, alice, AAPL, usd(10), usd(200));
      await trade(exchange, alice, AAPL, 0n, usd(100));
      expect((await exchange.positions(AAPL, alice.address)).margin).to.be.closeTo(usd(298), usd("0.01"));
      await trade(exchange, alice, AAPL, 0n, -usd(150));
      expect(await exchange.balances(alice.address)).to.be.closeTo(usd(850), usd("0.01"));
      // Pulling margin past initial margin (notional/20 = $100) fails
      await expect(trade(exchange, alice, AAPL, 0n, -usd(60))).to.be.revertedWithCustomError(
        exchange,
        "InsufficientMargin",
      );
    });

    it("enforces the minimum position margin", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await expect(trade(exchange, alice, AAPL, usd("0.01"), usd(5))).to.be.revertedWithCustomError(
        exchange,
        "MarginBelowMinimum",
      );
    });

    it("applies a skew premium: trades that grow the imbalance fill worse", async function () {
      const { exchange, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1_000_000));
      await exchange.connect(bob).deposit(usdc(1_000_000));
      await trade(exchange, alice, AAPL, usd(1000), usd(100_000));
      const longQuote = await exchange.quoteFillPrice(AAPL, usd(10));
      const shortQuote = await exchange.quoteFillPrice(AAPL, -usd(10));
      expect(longQuote).to.be.gt(usd(200));
      expect(shortQuote).to.be.gt(usd(200)); // short reduces skew and receives the premium
      expect(longQuote).to.be.gt(shortQuote);
    });

    it("lists every open position for a trader", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(2000));
      await exchange.connect(alice).createMarket("TSLA", feed("TSLA"), []);
      await trade(exchange, alice, AAPL, usd(1), usd(100));
      await trade(exchange, alice, 1, -usd(2), usd(100));
      const list = await exchange.getPositions(alice.address);
      expect(list.length).to.equal(2);
      expect(list[0].symbol).to.equal("AAPL");
      expect(list[1].symbol).to.equal("TSLA");
      expect(list[1].size).to.equal(-usd(2));
    });
  });

  describe("market hours, close-only and pause", function () {
    it("halts trading when the oracle is stale (market closed)", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await trade(exchange, alice, AAPL, usd(1), usd(100));
      await time.increase(61);
      await expect(trade(exchange, alice, AAPL, usd(1), usd(100))).to.be.revertedWithCustomError(
        exchange,
        "StalePrice",
      );
      await expect(exchange.connect(alice).closePosition(AAPL, 0, [])).to.be.revertedWithCustomError(
        exchange,
        "StalePrice",
      );
      await oracle.setPrice(feed("AAPL"), usd(200));
      await exchange.connect(alice).closePosition(AAPL, 0, []);
    });

    it("allows only reductions in inactive markets", async function () {
      const { exchange, owner, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await trade(exchange, alice, AAPL, usd(2), usd(100));
      await exchange.connect(owner).setMarketActive(AAPL, false);
      await expect(trade(exchange, alice, AAPL, usd(1), 0n)).to.be.revertedWithCustomError(
        exchange,
        "MarketNotActive",
      );
      await expect(trade(exchange, alice, AAPL, -usd(3), 0n)).to.be.revertedWithCustomError(
        exchange,
        "MarketNotActive",
      );
      await trade(exchange, alice, AAPL, -usd(1), 0n);
      await exchange.connect(alice).closePosition(AAPL, 0, []);
    });

    it("pausing blocks new risk but never exits", async function () {
      const { exchange, owner, alice, lp } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(1000));
      await trade(exchange, alice, AAPL, usd(2), usd(100));
      await exchange.connect(owner).pause();
      await expect(trade(exchange, alice, AAPL, usd(1), 0n)).to.be.revertedWithCustomError(exchange, "EnforcedPause");
      await expect(exchange.connect(alice).deposit(usdc(1))).to.be.revertedWithCustomError(exchange, "EnforcedPause");
      await exchange.connect(alice).closePosition(AAPL, 0, []);
      await exchange.connect(alice).withdraw(usdc(500));
      await time.increase(3601);
      await exchange.connect(lp).removeLiquidity(await exchange.lpShares(lp.address) / 10n, 0, []);
    });
  });

  describe("funding", function () {
    it("charges the crowded side and pays it to the vault and the other side", async function () {
      const { exchange, oracle, alice, bob } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(10_000));
      await exchange.connect(bob).deposit(usdc(10_000));
      await trade(exchange, alice, AAPL, usd(100), usd(2000));
      await trade(exchange, bob, AAPL, -usd(50), usd(2000));

      const m = await exchange.getMarketView(AAPL);
      // skew 50 / total OI 150 * 0.1%/day
      expect(m.fundingRate).to.equal(usd("0.001") / 3n);

      await time.increase(86_400);
      await oracle.setPrice(feed("AAPL"), usd(200));
      const a = await exchange.getPosition(AAPL, alice.address);
      const b = await exchange.getPosition(AAPL, bob.address);
      // index moves 0.000333 * $200 = $0.0667 per share per day
      expect(a.accruedFunding).to.be.closeTo(usd("6.6667"), usd("0.01"));
      expect(b.accruedFunding).to.be.closeTo(-usd("3.3333"), usd("0.01"));

      const rc = await (await exchange.connect(alice).closePosition(AAPL, 0, [])).wait();
      expect(eventArgs(rc, exchange, "PositionModified").fundingPaid).to.be.closeTo(usd("6.6667"), usd("0.01"));
    });
  });

  describe("liquidations", function () {
    async function openRiskyLong() {
      const f = await loadFixture(deployFixture);
      await f.exchange.connect(f.alice).deposit(usdc(1100));
      await trade(f.exchange, f.alice, AAPL, usd(100), usd(1100)); // $20k notional, ~18.5x
      return f;
    }

    it("reports a liquidation price consistent with the maintenance margin", async function () {
      const { exchange, alice } = await openRiskyLong();
      const pos = await exchange.getPosition(AAPL, alice.address);
      expect(pos.liquidationPrice).to.be.closeTo(usd("194.05"), usd("0.05"));
      expect(pos.liquidatable).to.equal(false);
    });

    it("rejects liquidating a healthy position", async function () {
      const { exchange, oracle, alice, liquidator } = await openRiskyLong();
      await oracle.setPrice(feed("AAPL"), usd(195));
      await expect(
        exchange.connect(liquidator).liquidate(AAPL, alice.address, []),
      ).to.be.revertedWithCustomError(exchange, "NotLiquidatable");
    });

    it("liquidates below maintenance, paying the liquidator and returning the rest", async function () {
      const { exchange, oracle, alice, liquidator } = await openRiskyLong();
      await oracle.setPrice(feed("AAPL"), usd(193));
      expect((await exchange.getPosition(AAPL, alice.address)).liquidatable).to.equal(true);
      const vaultBefore = await exchange.vaultBalance();

      const rc = await (await exchange.connect(liquidator).liquidate(AAPL, alice.address, [])).wait();
      const ev = eventArgs(rc, exchange, "Liquidated");
      expect(ev.reward).to.be.closeTo(usd("96.5"), usd("0.01")); // 0.5% of $19,300
      expect(ev.badDebt).to.equal(0);
      expect(await exchange.balances(liquidator.address)).to.equal(ev.reward);
      const aliceBal = await exchange.balances(alice.address);
      expect(aliceBal).to.be.closeTo(usd("283.5"), usd("0.5"));
      // vault gains the trader's loss
      expect((await exchange.vaultBalance()) - vaultBefore).to.be.closeTo(usd(700), usd("0.5"));
      expect((await exchange.positions(AAPL, alice.address)).size).to.equal(0);
      const m = await exchange.getMarket(AAPL);
      expect(m.longOpenInterest).to.equal(0);
      expect(m.netCostBasis).to.equal(0);
    });

    it("absorbs bad debt in the vault and still pays the minimum reward", async function () {
      const { exchange, oracle, alice, liquidator } = await openRiskyLong();
      await oracle.setPrice(feed("AAPL"), usd(180));
      const rc = await (await exchange.connect(liquidator).liquidate(AAPL, alice.address, [])).wait();
      const ev = eventArgs(rc, exchange, "Liquidated");
      expect(ev.badDebt).to.be.closeTo(usd(920), usd("0.5"));
      expect(ev.reward).to.equal(usd(1));
      expect(await exchange.balances(alice.address)).to.equal(0);
    });

    it("prevents an underwater trader from closing to dodge liquidation", async function () {
      const { exchange, oracle, alice } = await openRiskyLong();
      await oracle.setPrice(feed("AAPL"), usd(180));
      await expect(exchange.connect(alice).closePosition(AAPL, 0, [])).to.be.revertedWithCustomError(
        exchange,
        "PositionUnderwater",
      );
    });
  });

  describe("liquidity vault", function () {
    it("accrues trading fees to LPs", async function () {
      const { exchange, alice } = await loadFixture(deployFixture);
      const before = await exchange.lpSharePrice();
      await exchange.connect(alice).deposit(usdc(10_000));
      await trade(exchange, alice, AAPL, usd(100), usd(5000));
      await exchange.connect(alice).closePosition(AAPL, 0, []);
      expect(await exchange.lpSharePrice()).to.be.gt(before);
    });

    it("marks open trader PnL into NAV", async function () {
      const { exchange, oracle, alice } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(10_000));
      await trade(exchange, alice, AAPL, usd(100), usd(5000));
      const navBefore = await exchange.vaultNav();
      await oracle.setPrice(feed("AAPL"), usd(210)); // trader +$1000
      const navAfter = await exchange.vaultNav();
      expect(navBefore - navAfter).to.be.closeTo(usd(1000), usd("0.5"));
    });

    it("locks new LP shares and pays out pro-rata NAV", async function () {
      const { exchange, usdcToken, bob } = await loadFixture(deployFixture);
      const shares = await exchange.connect(bob).addLiquidity.staticCall(usdc(10_000), 0, []);
      await exchange.connect(bob).addLiquidity(usdc(10_000), 0, []);
      await expect(exchange.connect(bob).removeLiquidity(shares, 0, [])).to.be.revertedWithCustomError(
        exchange,
        "SharesLocked",
      );
      await time.increase(3601);
      const before = await usdcToken.balanceOf(bob.address);
      await exchange.connect(bob).removeLiquidity(shares, 0, []);
      expect((await usdcToken.balanceOf(bob.address)) - before).to.be.closeTo(usdc(10_000), usdc("0.01"));
    });

    it("caps vault utilization for new exposure and LP withdrawals", async function () {
      const { exchange, oracle, alice, lp } = await loadFixture(deployFixture);
      await exchange.connect(alice).deposit(usdc(200_000));
      // net skew $1.2M > vault ~$1.0M
      await expect(trade(exchange, alice, AAPL, usd(6000), usd(200_000))).to.be.revertedWithCustomError(
        exchange,
        "InsufficientLiquidity",
      );
      await trade(exchange, alice, AAPL, usd(4000), usd(100_000)); // $800k skew
      await time.increase(3601);
      await expect(exchange.connect(lp).removeLiquidity(1n, 0, [])).to.be.revertedWithCustomError(
        exchange,
        "StalePrice",
      ); // NAV needs fresh prices for markets with open interest
      await oracle.setPrice(feed("AAPL"), usd(200));
      const shares = await exchange.lpShares(lp.address);
      await expect(exchange.connect(lp).removeLiquidity(shares / 2n, 0, [])).to.be.revertedWithCustomError(
        exchange,
        "InsufficientLiquidity",
      );
      await exchange.connect(lp).removeLiquidity(shares / 10n, 0, []);
    });

    it("enforces per-market open interest caps", async function () {
      const { exchange, owner, alice } = await loadFixture(deployFixture);
      await exchange.connect(owner).setMarketParams(AAPL, { ...DEFAULT_PARAMS, maxOpenInterest: usd(10_000) });
      await exchange.connect(alice).deposit(usdc(10_000));
      await trade(exchange, alice, AAPL, usd(40), usd(1000));
      await expect(trade(exchange, alice, AAPL, usd(20), usd(1000))).to.be.revertedWithCustomError(
        exchange,
        "OpenInterestCapExceeded",
      );
      await trade(exchange, alice, AAPL, -usd(80), usd(1000)); // flip to 40 short is fine
    });
  });

  describe("admin", function () {
    it("restricts admin functions and validates params", async function () {
      const { exchange, alice, owner } = await loadFixture(deployFixture);
      await expect(exchange.connect(alice).pause()).to.be.revertedWithCustomError(
        exchange,
        "OwnableUnauthorizedAccount",
      );
      await expect(
        exchange.connect(owner).setMarketParams(AAPL, { ...DEFAULT_PARAMS, maintenanceMargin: usd("0.06") }),
      ).to.be.revertedWithCustomError(exchange, "InvalidParams");
      await expect(
        exchange.connect(owner).setDefaultMarketParams({ ...DEFAULT_PARAMS, maxLeverage: usd(101) }),
      ).to.be.revertedWithCustomError(exchange, "InvalidParams");
    });
  });
});

describe("MockOracle", function () {
  it("only lets non-reporters seed unreported feeds when permissionless init is on", async function () {
    const { oracle, owner, alice } = await loadFixture(deployFixture);
    await expect(oracle.connect(alice).initPrice(feed("COIN"), usd(300))).to.be.revertedWithCustomError(
      oracle,
      "NotReporter",
    );
    await oracle.connect(owner).setPermissionlessInit(true);
    await oracle.connect(alice).initPrice(feed("COIN"), usd(300));
    expect((await oracle.getPrice(feed("COIN")))[0]).to.equal(usd(300));
    await expect(oracle.connect(alice).initPrice(feed("COIN"), usd(1))).to.be.revertedWithCustomError(
      oracle,
      "AlreadyInitialized",
    );
    await expect(oracle.connect(alice).setPrice(feed("COIN"), usd(1))).to.be.revertedWithCustomError(
      oracle,
      "NotReporter",
    );
  });
});
