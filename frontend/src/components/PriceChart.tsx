import { useEffect, useMemo, useRef, useState } from "react";

interface Props {
  points: { t: number; p: number }[];
  entry?: number;
  liquidation?: number;
}

const PAD = { l: 8, r: 64, t: 16, b: 16 };

export function PriceChart({ points, entry, liquidation }: Props) {
  // Draw in real pixels so text and strokes never stretch.
  const ref = useRef<HTMLDivElement>(null);
  const [{ W, H }, setSize] = useState({ W: 800, H: 280 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setSize({ W: Math.max(200, e.contentRect.width), H: Math.max(120, e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const geo = useMemo(() => {
    if (points.length < 2) return undefined;
    const ps = points.map((x) => x.p);
    const refs = [entry, liquidation].filter((x): x is number => !!x && x > 0);
    let lo = Math.min(...ps);
    let hi = Math.max(...ps);
    // Include reference lines only if they're near the visible range.
    for (const r of refs) if (r > lo * 0.9 && r < hi * 1.1) ((lo = Math.min(lo, r)), (hi = Math.max(hi, r)));
    const span = hi - lo || hi * 0.001 || 1;
    lo -= span * 0.08;
    hi += span * 0.08;
    const t0 = points[0].t;
    const t1 = points[points.length - 1].t;
    const x = (t: number) => PAD.l + ((t - t0) / (t1 - t0 || 1)) * (W - PAD.l - PAD.r);
    const y = (p: number) => PAD.t + (1 - (p - lo) / (hi - lo)) * (H - PAD.t - PAD.b);
    const line = points.map((pt, i) => `${i ? "L" : "M"}${x(pt.t).toFixed(1)},${y(pt.p).toFixed(1)}`).join("");
    const area = `${line}L${x(t1).toFixed(1)},${H - PAD.b}L${x(t0).toFixed(1)},${H - PAD.b}Z`;
    const up = points[points.length - 1].p >= points[0].p;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
    return { line, area, up, y, ticks, lo, hi, last: points[points.length - 1], x };
  }, [points, entry, liquidation, W, H]);

  if (!geo) {
    return (
      <div className="panel chart" ref={ref}>
        <div className="chart-empty">Collecting live oracle prices…</div>
      </div>
    );
  }
  const inRange = (v?: number) => !!v && v >= geo.lo && v <= geo.hi;
  return (
    <div className="panel chart" ref={ref}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Live price chart">
        <defs>
          <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={geo.up ? "var(--up)" : "var(--down)"} stopOpacity="0.22" />
            <stop offset="100%" stopColor={geo.up ? "var(--up)" : "var(--down)"} stopOpacity="0" />
          </linearGradient>
        </defs>
        {geo.ticks.map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(v)} y2={geo.y(v)} className="grid" />
            <text x={W - PAD.r + 6} y={geo.y(v) + 4} className="axis">
              {v.toFixed(2)}
            </text>
          </g>
        ))}
        <path d={geo.area} fill="url(#fill)" />
        <path d={geo.line} className={`price-line ${geo.up ? "up" : "down"}`} />
        {inRange(entry) && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(entry!)} y2={geo.y(entry!)} className="ref entry" />
            <text x={PAD.l + 4} y={geo.y(entry!) - 4} className="ref-label">
              Entry {entry!.toFixed(2)}
            </text>
          </g>
        )}
        {inRange(liquidation) && (
          <g>
            <line x1={PAD.l} x2={W - PAD.r} y1={geo.y(liquidation!)} y2={geo.y(liquidation!)} className="ref liq" />
            <text x={PAD.l + 4} y={geo.y(liquidation!) - 4} className="ref-label liq">
              Liquidation {liquidation!.toFixed(2)}
            </text>
          </g>
        )}
        <circle cx={geo.x(geo.last.t)} cy={geo.y(geo.last.p)} r="3.5" className={`dot ${geo.up ? "up" : "down"}`} />
      </svg>
    </div>
  );
}
