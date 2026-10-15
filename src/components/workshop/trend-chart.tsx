import { useMemo, useState } from "react";

import { shortDate } from "@/lib/format";
import { cn } from "@/lib/utils";

export interface TrendPoint {
  /** Milliseconds since the Unix epoch. */
  at: number;
  value: number;
}

interface TrendChartProps {
  points: TrendPoint[];
  /** What the values are, for the summary read to screen readers. */
  label: string;
  format: (value: number) => string;
  className?: string;
}

/** Chart coordinates run 0–100 on both axes; this keeps the line off the edges. */
const PAD = 4;

/** A single-series line over time with a crosshair and tooltip on hover. */
export function TrendChart({ points, label, format, className }: TrendChartProps) {
  const [hover, setHover] = useState<number | null>(null);

  const { coords, min, max } = useMemo(() => {
    const values = points.map((p) => p.value);
    const low = Math.min(...values);
    const high = Math.max(...values);
    const first = points[0]?.at ?? 0;
    const span = Math.max((points[points.length - 1]?.at ?? 0) - first, 1);
    // A flat line sits in the middle rather than on the floor.
    const range = high - low || 1;
    const coords = points.map((p) => ({
      x: PAD + ((p.at - first) / span) * (100 - 2 * PAD),
      y: high === low ? 50 : PAD + (1 - (p.value - low) / range) * (100 - 2 * PAD),
    }));
    return { coords, min: low, max: high };
  }, [points]);

  if (points.length < 2) return null;

  const line = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x} ${c.y}`).join(" ");
  const area = `${line} L${coords[coords.length - 1].x} ${100 - PAD} L${coords[0].x} ${100 - PAD} Z`;
  const first = points[0];
  const last = points[points.length - 1];
  const current = hover === null ? null : { point: points[hover], at: coords[hover] };

  function pick(e: React.PointerEvent<HTMLDivElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    let nearest = 0;
    for (let i = 1; i < coords.length; i++) {
      if (Math.abs(coords[i].x - x) < Math.abs(coords[nearest].x - x)) nearest = i;
    }
    setHover(nearest);
  }

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <p className="sr-only">
        {label}: {format(first.value)} on {shortDate(first.at)}, {format(last.value)} on {shortDate(last.at)}.
      </p>
      <div className="flex gap-2">
        <div className="flex w-10 shrink-0 flex-col justify-between text-right text-xs text-muted-foreground tabular-nums" aria-hidden>
          <span>{format(max)}</span>
          <span>{format(min)}</span>
        </div>
        <div
          className="relative h-32 min-w-0 flex-1 touch-none"
          onPointerMove={pick}
          onPointerLeave={() => setHover(null)}
          aria-hidden
        >
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="absolute inset-0 size-full overflow-visible">
            <line x1={PAD} y1={100 - PAD} x2={100 - PAD} y2={100 - PAD} className="stroke-border" vectorEffect="non-scaling-stroke" />
            <path d={area} className="fill-primary/10" />
            <path d={line} fill="none" className="stroke-primary" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
          </svg>
          {current && (
            <>
              <span className="pointer-events-none absolute top-0 bottom-0 w-px bg-foreground/30" style={{ left: `${current.at.x}%` }} />
              <span
                className="pointer-events-none absolute size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
                style={{ left: `${current.at.x}%`, top: `${current.at.y}%` }}
              />
              <span
                className={cn(
                  "pointer-events-none absolute top-0 rounded-md bg-foreground px-2 py-1 text-xs whitespace-nowrap text-background tabular-nums",
                  current.at.x > 60 ? "-translate-x-[calc(100%+8px)]" : "translate-x-2",
                )}
                style={{ left: `${current.at.x}%` }}
              >
                <span className="font-medium">{format(current.point.value)}</span>
                <span className="text-background/70"> · {shortDate(current.point.at)}</span>
              </span>
            </>
          )}
        </div>
      </div>
      <div className="flex justify-between pl-12 text-xs text-muted-foreground tabular-nums" aria-hidden>
        <span>{shortDate(first.at)}</span>
        <span>{shortDate(last.at)}</span>
      </div>
    </div>
  );
}
