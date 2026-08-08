/**
 * Net worth over time — one series, inline SVG, no charting library.
 *
 * Deliberate choices, in the order the dataviz method asks for them:
 *
 *  1. FORM. The data's job is change-over-time for a single measure, so: a line.
 *     Assets and liabilities are deliberately NOT plotted alongside it — they
 *     live at a different magnitude and would either need a second y-axis (never
 *     acceptable) or flatten the series that matters. They are in the table
 *     below instead, which is the accessible view of the same numbers.
 *  2. COLOR. One series needs no categorical palette and no legend box — the
 *     heading names it. It uses the app's existing accent, which is already
 *     *selected* per theme rather than flipped: `--accent` is a different green
 *     in light and dark mode, each chosen against its own surface.
 *  3. MARKS. 2px line, recessive grid, direct labels on the first and last
 *     points only — never a number on every point.
 *  4. INTERACTION. Every point carries a generous transparent hit circle with a
 *     native <title>, so hovering any point gives its date and value. That keeps
 *     this a server component: no client JS ships for a read-only chart, and the
 *     tooltip still works with JS disabled.
 *
 * A zero baseline is drawn whenever the range crosses it, and the range is
 * always extended to include zero. With a negative net worth — which is the
 * common case early in a mortgage — a chart that floated the axis would hide
 * the single most important fact about the series.
 */

export interface ChartPoint {
  asOfDate: string;
  netWorth: number;
  assets: number;
  liabilities: number;
  label: string;
}

const WIDTH = 720;
const HEIGHT = 220;
const PAD = { top: 18, right: 16, bottom: 26, left: 16 };

export function NetWorthChart({ points }: { points: ChartPoint[] }) {
  if (points.length === 0) return null;

  const values = points.map((p) => p.netWorth);
  // Zero is always in range: an axis that floats above a negative series would
  // hide whether the user is above or below water at all.
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(0, ...values);
  // A flat series would otherwise divide by zero; give it a band to sit in.
  const span = rawMax - rawMin || Math.max(Math.abs(rawMax), 1) * 2;
  const min = rawMin - span * 0.08;
  const max = rawMax + span * 0.08;

  const plotW = WIDTH - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;

  const x = (i: number): number =>
    points.length === 1 ? PAD.left + plotW / 2 : PAD.left + (i / (points.length - 1)) * plotW;
  const y = (value: number): number => PAD.top + ((max - value) / (max - min)) * plotH;

  const zeroY = y(0);
  const crossesZero = rawMin < 0 && rawMax > 0;

  const line = points.map((p, i) => `${x(i).toFixed(1)},${y(p.netWorth).toFixed(1)}`).join(' ');
  // The area closes onto the zero line rather than the bottom of the plot, so
  // the fill reads as "distance from break-even" instead of a meaningless slab.
  const area = `${line} ${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)} ${x(0).toFixed(1)},${zeroY.toFixed(1)}`;

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const lastY = y(last.netWorth);

  return (
    <figure className="chart">
      {/*
        No `preserveAspectRatio="none"`: stretching the viewBox would turn the
        point markers into ellipses and skew the line's apparent slope.
      */}
      <svg
        viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
        role="img"
        aria-label={`Net worth from ${first.asOfDate} to ${last.asOfDate}. Latest ${last.label}.`}
      >
        {/* Recessive gridlines: quartiles of the value range, no labels. */}
        {[0.25, 0.5, 0.75].map((fraction) => {
          const gy = PAD.top + fraction * plotH;
          return (
            <line
              className="chart-grid"
              key={fraction}
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={gy}
              y2={gy}
            />
          );
        })}

        {crossesZero && (
          <>
            <line
              className="chart-zero"
              x1={PAD.left}
              x2={WIDTH - PAD.right}
              y1={zeroY}
              y2={zeroY}
            />
            <text className="chart-zero-label" x={PAD.left} y={zeroY - 5}>
              break even
            </text>
          </>
        )}

        {points.length > 1 && <polygon className="chart-area" points={area} />}
        {points.length > 1 && <polyline className="chart-line" points={line} />}

        {/* The most recent point is the one worth marking. */}
        <circle className="chart-dot" cx={x(points.length - 1)} cy={lastY} r={4} />

        {/*
          Hit targets, generously sized and invisible. Native <title> gives a
          tooltip on hover with no client JavaScript at all.
        */}
        {points.map((p, i) => (
          <circle
            className="chart-hit"
            key={p.asOfDate}
            cx={x(i)}
            cy={y(p.netWorth)}
            r={10}
          >
            <title>{`${p.asOfDate}: ${p.label}`}</title>
          </circle>
        ))}

        {/* Selective direct labels — endpoints only, never every point. */}
        <text className="chart-axis" x={PAD.left} y={HEIGHT - 8}>
          {first.asOfDate}
        </text>
        {points.length > 1 && (
          <text className="chart-axis end" x={WIDTH - PAD.right} y={HEIGHT - 8}>
            {last.asOfDate}
          </text>
        )}
      </svg>
      <figcaption className="faint">
        Hover any point for its date and value. The full series is in the table below.
      </figcaption>
    </figure>
  );
}
