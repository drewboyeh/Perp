import { useEffect, useRef, useState } from "react";
import {
  AreaSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { candleSnapshot, type Interval } from "../hl/api";

export type ChartStyle = "candles" | "line";

const INTERVAL_MS: Record<Interval, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
  "1w": 604_800_000,
};
const BARS = 300;

/** "#rrggbb" plus alpha as an rgba() string (the chart's color parser doesn't take color-mix). */
function withAlpha(hex: string, alpha: number) {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Reads the current theme's colors so the canvas matches light and dark mode. */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { ink: v("--ink"), muted: v("--muted"), grid: v("--grid"), up: v("--buy"), down: v("--sell") };
}

interface Props {
  coin: string;
  interval: Interval;
  style: ChartStyle;
  livePx?: number;
}

export function Chart({ coin, interval, style, livePx }: Props) {
  const el = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>();
  const series = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Area">>();
  const last = useRef<{ time: UTCTimestamp; open: number; high: number; low: number; close: number }>();
  const live = useRef(livePx);
  live.current = livePx;
  const [error, setError] = useState<string>();

  /** Moves the latest bar to the live price so the chart agrees with the quote. */
  const applyLive = () => {
    const s = series.current;
    const b = last.current;
    const px = live.current;
    if (!s || !b || !px) return;
    const next = { ...b, close: px, high: Math.max(b.high, px), low: Math.min(b.low, px) };
    last.current = next;
    if (style === "candles") (s as ISeriesApi<"Candlestick">).update(next);
    else (s as ISeriesApi<"Area">).update({ time: next.time, value: px });
  };

  // One chart per mount; recolor when the system theme flips.
  useEffect(() => {
    if (!el.current) return;
    const c = themeColors();
    chart.current = createChart(el.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: c.muted,
        fontFamily: "'Instrument Sans', system-ui, sans-serif",
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: c.grid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.28, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, rightOffset: 4 },
      crosshair: { horzLine: { labelBackgroundColor: c.ink }, vertLine: { labelBackgroundColor: c.ink } },
      handleScale: { axisPressedMouseMove: false },
    });
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const recolor = () => {
      const t = themeColors();
      chart.current?.applyOptions({ layout: { textColor: t.muted }, grid: { horzLines: { color: t.grid } } });
    };
    mq.addEventListener("change", recolor);
    return () => {
      mq.removeEventListener("change", recolor);
      chart.current?.remove();
      chart.current = undefined;
    };
  }, []);

  // (Re)load history whenever the market, timeframe or style changes, and refresh it every 30s.
  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    const t = themeColors();
    const s =
      style === "candles"
        ? c.addSeries(CandlestickSeries, {
            upColor: t.up,
            downColor: t.down,
            wickUpColor: t.up,
            wickDownColor: t.down,
            borderVisible: false,
            priceLineColor: t.ink,
          })
        : c.addSeries(AreaSeries, {
            lineColor: t.ink,
            lineWidth: 2,
            topColor: withAlpha(t.ink, 0.14),
            bottomColor: withAlpha(t.ink, 0),
            priceLineColor: t.ink,
          });
    series.current = s;
    let live = true;
    let fitted = false;
    const load = async () => {
      try {
        const candles = await candleSnapshot(coin, interval, Date.now() - BARS * INTERVAL_MS[interval]);
        if (!live) return;
        const bars = candles.map((k) => ({
          time: Math.floor(k.t / 1000) as UTCTimestamp,
          open: Number(k.o),
          high: Number(k.h),
          low: Number(k.l),
          close: Number(k.c),
        }));
        if (style === "candles") (s as ISeriesApi<"Candlestick">).setData(bars);
        else (s as ISeriesApi<"Area">).setData(bars.map((b) => ({ time: b.time, value: b.close })));
        last.current = bars[bars.length - 1];
        applyLive();
        if (!fitted) c.timeScale().fitContent();
        fitted = true;
        setError(bars.length ? undefined : "No trades in this timeframe yet.");
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = setInterval(load, 30_000);
    return () => {
      live = false;
      clearInterval(id);
      if (chart.current === c) c.removeSeries(s); // the chart itself may already be gone
      series.current = undefined;
      last.current = undefined;
    };
  }, [coin, interval, style]);

  // Move the latest bar with the live price between history refreshes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(applyLive, [livePx]);

  return (
    <div className="chart">
      <div ref={el} className="chart-canvas" />
      {error && <p className="chart-msg">{error}</p>}
    </div>
  );
}
