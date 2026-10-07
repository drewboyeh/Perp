import { describe, expect, it } from "vitest";
import { feeToPercent, formatPrice, formatSize, slippagePrice } from "./format";
import { assetId } from "./markets";

describe("Hyperliquid price and size rules", () => {
  it("keeps at most 5 significant figures and 6 - szDecimals decimals", () => {
    expect(formatPrice(184.6789, 2)).toBe("184.68");
    expect(formatPrice(1234.567, 1)).toBe("1234.6");
    expect(formatPrice(0.123456789, 0)).toBe("0.12346");
    expect(formatPrice(0.0012345678, 3)).toBe("0.001"); // only 3 decimals allowed
    expect(formatPrice(123456.7, 0)).toBe("123460");
    expect(formatPrice(250, 2)).toBe("250"); // integers always allowed
  });

  it("rounds sizes down to szDecimals", () => {
    expect(formatSize(1.23999, 2)).toBe("1.23");
    expect(formatSize(5, 2)).toBe("5");
    expect(formatSize(0.1 + 0.2, 1)).toBe("0.3");
    expect(formatSize(0.004, 2)).toBe("0");
  });

  it("moves market-order prices against the trader", () => {
    expect(slippagePrice(200, true, 0.01, 2)).toBe("202");
    expect(slippagePrice(200, false, 0.01, 2)).toBe("198");
  });

  it("formats builder fees as percent strings", () => {
    expect(feeToPercent(30)).toBe("0.03%");
    expect(feeToPercent(100)).toBe("0.1%");
    expect(feeToPercent(5)).toBe("0.005%");
  });

  it("maps builder-deployed dex assets like the SDK (110000 + i * 10000 for perpDexs[1:])", () => {
    expect(assetId(1, 0)).toBe(110000);
    expect(assetId(1, 7)).toBe(110007);
    expect(assetId(2, 3)).toBe(120003);
  });
});
