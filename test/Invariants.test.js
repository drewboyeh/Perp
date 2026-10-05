const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { usd, usdc, feed, DEFAULT_RISK, DEFAULT_PARAMS } = require("./helpers");

// Deterministic PRNG so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("Solvency invariant (randomized)", function () {
  this.timeout(300_000);

  for (const seed of [1, 2, 3]) {
    it(`token balance always equals account balances + margins + vault (seed ${seed})`, async function () {
      const rand = rng(seed);
      const signers = await ethers.getSigners();
      const [owner, lp, keeper] = signers;
      const traders = signers.slice(3, 8);
      const symbols = ["AAPL", "TSLA", "NVDA"];
      const prices = { AAPL: 200, TSLA: 250, NVDA: 120 };

      const token = await ethers.deployContract("MockUSDC");
      const oracle = await ethers.deployContract("MockOracle");
      const exchange = await ethers.deployContract("PerpExchange", [
        await token.getAddress(),
        await oracle.getAddress(),
        { ...DEFAULT_RISK, maxPriceAge: 3600n * 24n },
        { ...DEFAULT_PARAMS, skewScale: usd(5_000_000), maxFundingRate: usd("0.05") },
      ]);
      const everyone = [owner, lp, keeper, ...traders];
      for (const s of everyone) {
        await token.mint(s.address, usdc(1_000_000));
        await token.connect(s).approve(await exchange.getAddress(), ethers.MaxUint256);
      }
      const pushPrices = async () => {
        for (const sym of symbols) await oracle.setPrice(feed(sym), usd(prices[sym].toFixed(6)));
      };
      await pushPrices();
      await exchange.connect(lp).addLiquidity(usdc(300_000), 0, []);
      await exchange.connect(owner).deposit(usdc(1000));
      for (const sym of symbols) await exchange.connect(owner).createMarket(sym, feed(sym), []);
      for (const t of traders) await exchange.connect(t).deposit(usdc(20_000));

      const checkInvariant = async () => {
        let accounted = await exchange.vaultBalance();
        for (const s of everyone) accounted += await exchange.balances(s.address);
        for (let m = 0; m < symbols.length; m++) {
          for (const t of traders) accounted += (await exchange.positions(m, t.address)).margin;
        }
        const held = (await token.balanceOf(await exchange.getAddress())) * 10n ** 12n;
        expect(held).to.equal(accounted);
      };

      let ok = 0;
      for (let step = 0; step < 80; step++) {
        const r = rand();
        const t = traders[Math.floor(rand() * traders.length)];
        const m = Math.floor(rand() * symbols.length);
        try {
          if (r < 0.45) {
            const size = usd(((rand() - 0.5) * 200).toFixed(4));
            const margin = usd((rand() * 1500).toFixed(2));
            const acceptable = size >= 0n ? ethers.MaxUint256 : 0n;
            await exchange.connect(t).modifyPosition(m, size, margin, acceptable, []);
          } else if (r < 0.55) {
            await exchange.connect(t).closePosition(m, (await exchange.positions(m, t.address)).size > 0n ? 0n : ethers.MaxUint256, []);
          } else if (r < 0.65) {
            const delta = usd(((rand() - 0.5) * 400).toFixed(2));
            await exchange.connect(t).modifyPosition(m, 0n, delta, 0n, []);
          } else if (r < 0.85) {
            const sym = symbols[m];
            prices[sym] *= 1 + (rand() - 0.5) * 0.16;
            await time.increase(Math.floor(rand() * 7200));
            await pushPrices();
          } else {
            for (const victim of traders) {
              const pos = await exchange.getPosition(m, victim.address);
              if (pos.liquidatable) await exchange.connect(keeper).liquidate(m, victim.address, []);
            }
          }
          ok++;
        } catch (e) {
          // Expected business reverts (leverage, margin, caps); anything else is a bug.
          const msg = String(e.message);
          const known = [
            "InsufficientMargin",
            "InsufficientBalance",
            "MarginBelowMinimum",
            "PositionUnderwater",
            "NoPosition",
            "NothingToDo",
            "InsufficientLiquidity",
            "OpenInterestCapExceeded",
          ];
          if (!known.some((k) => msg.includes(k))) throw e;
        }
        await checkInvariant();
      }
      if (process.env.DEBUG_FUZZ) console.log(`seed ${seed}: ${ok}/80 ops succeeded`);
      expect(ok).to.be.gt(40);

      // Wind everything down: liquidate what's liquidatable, close the rest.
      await pushPrices();
      for (let m = 0; m < symbols.length; m++) {
        for (const t of traders) {
          const pos = await exchange.getPosition(m, t.address);
          if (pos.size === 0n) continue;
          if (pos.liquidatable) await exchange.connect(keeper).liquidate(m, t.address, []);
          else await exchange.connect(t).closePosition(m, pos.size > 0n ? 0n : ethers.MaxUint256, []);
        }
        const mk = await exchange.getMarket(m);
        expect(mk.longOpenInterest).to.equal(0);
        expect(mk.shortOpenInterest).to.equal(0);
        expect(mk.netCostBasis).to.equal(0);
        expect(mk.netFundingBasis).to.equal(0);
      }
      await checkInvariant();
      expect(await exchange.totalSkewNotional()).to.equal(0);
      // With no open positions NAV is exactly the vault balance.
      expect(await exchange.vaultNav()).to.equal(await exchange.vaultBalance());

      // Everyone can withdraw everything.
      for (const s of everyone) {
        const bal = (await exchange.balances(s.address)) / 10n ** 12n;
        if (bal > 0n) await exchange.connect(s).withdraw(bal);
      }
    });
  }
});
