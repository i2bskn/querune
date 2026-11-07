import { type KeyboardEvent, type PointerEvent, useEffect, useId, useRef, useState } from "react";
import type { InsightsMemo } from "../../../src/api/types";
import { Link } from "../Link";
import { formatShortDate, localDate, weekday } from "../numbers";

// Charts drawn as SVG from the figures of the API. No chart library: the dashboard needs a line with the previous
// period behind it, memo marks under the days, and a reading of one day at a time.

export type ChartTone = "search" | "muted" | "sessions";

type Size = { width: number };

// The width of the element, followed as it changes.
function useWidth<T extends HTMLElement>(fallback: number): [React.RefObject<T | null>, Size] {
  const ref = useRef<T>(null);
  const [size, setSize] = useState<Size>({ width: fallback });
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width !== undefined && width > 0) setSize({ width: Math.round(width) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, size];
}

// 1, 2, 2.5 or 5 times a power of ten, so that the axis reads in round numbers.
function niceStep(range: number, count: number): number {
  const raw = range / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * power >= raw) return m * power;
  return 10 * power;
}

function domainOf(values: (number | null)[], invert: boolean): { min: number; max: number; ticks: number[] } {
  const numbers = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (numbers.length === 0) return { min: 0, max: 1, ticks: [0, 1] };
  let min = invert ? Math.min(...numbers) : 0;
  let max = Math.max(...numbers);
  if (invert) {
    min = Math.max(1, Math.floor(min));
    max = Math.ceil(max);
  }
  if (max === min) max = min + 1;
  const step = niceStep(max - min, 4);
  const lo = invert ? Math.max(invert ? 1 : 0, Math.floor(min / step) * step) : 0;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Math.round(t * 1000) / 1000);
  return { min: lo, max: hi, ticks };
}

// The path of a line through the values, broken where a value is missing.
function linePath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number): string {
  let d = "";
  let drawing = false;
  values.forEach((value, i) => {
    if (value === null) {
      drawing = false;
      return;
    }
    d += `${drawing ? "L" : "M"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    drawing = true;
  });
  return d;
}

function areaPath(values: (number | null)[], x: (i: number) => number, y: (v: number) => number, base: number): string {
  let d = "";
  let start: number | null = null;
  let last = 0;
  const close = () => {
    if (start !== null) d += `L${x(last).toFixed(1)},${base}L${x(start).toFixed(1)},${base}Z`;
    start = null;
  };
  values.forEach((value, i) => {
    if (value === null) {
      close();
      return;
    }
    d += `${start === null ? "M" : "L"}${x(i).toFixed(1)},${y(value).toFixed(1)}`;
    if (start === null) start = i;
    last = i;
  });
  close();
  return d;
}

export type MemoMark = InsightsMemo & { date: string };

// The memos placed on the days of dates by the browser's date.
export function memoMarks(memos: InsightsMemo[], dates: string[]): Map<number, MemoMark[]> {
  const index = new Map(dates.map((date, i) => [date, i]));
  const marks = new Map<number, MemoMark[]>();
  for (const memo of memos) {
    const date = localDate(memo.created_at);
    const i = index.get(date);
    if (i === undefined) continue;
    const list = marks.get(i) ?? [];
    list.push({ ...memo, date });
    marks.set(i, list);
  }
  return marks;
}

const MARGIN = { top: 14, right: 14, bottom: 26, left: 52 };
const LANE = 56;

// A line of the days of the period, the previous period behind it, and the memos as marks under the days. The
// pointer or the arrow keys read one day at a time.
export function TrendChart({
  label,
  dates,
  values,
  previous,
  previousDates,
  format,
  invert = false,
  tone,
  memos,
  highlight = null,
  markers = [],
  height = 280,
}: {
  label: string;
  dates: string[];
  values: (number | null)[];
  previous: (number | null)[] | null;
  previousDates: string[] | null;
  format: (value: number) => string;
  // Smaller is better (the search position): drawn upside down.
  invert?: boolean;
  tone: ChartTone;
  memos: InsightsMemo[];
  // The memo to tell apart from the others (the memo being read).
  highlight?: string | null;
  // Days to mark with a labeled rule (the publication of an article).
  markers?: { date: string; label: string }[];
  height?: number;
}) {
  const [ref, { width }] = useWidth<HTMLDivElement>(720);
  const gradientId = useId();
  const hatchId = `${gradientId}-hatch`;
  const [active, setActive] = useState<number | null>(null);
  const plotWidth = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const domain = domainOf([...values, ...(previous ?? [])], invert);
  const step = dates.length > 1 ? plotWidth / (dates.length - 1) : 0;
  const x = (i: number) => MARGIN.left + (dates.length > 1 ? i * step : plotWidth / 2);
  const y = (v: number) => {
    const t = (v - domain.min) / (domain.max - domain.min || 1);
    return MARGIN.top + (invert ? t : 1 - t) * plotHeight;
  };
  const base = MARGIN.top + plotHeight;
  const marks = memoMarks(memos, dates);

  const labelEvery = Math.max(1, Math.ceil(dates.length / Math.max(2, Math.floor(plotWidth / 76))));

  function indexAt(clientX: number, element: Element): number {
    const rect = element.getBoundingClientRect();
    const offset = clientX - rect.left - MARGIN.left;
    if (dates.length <= 1) return 0;
    return Math.min(dates.length - 1, Math.max(0, Math.round(offset / step)));
  }

  function onPointerMove(event: PointerEvent<SVGRectElement>) {
    const svg = event.currentTarget.ownerSVGElement;
    if (svg !== null) setActive(indexAt(event.clientX, svg));
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (dates.length === 0) return;
    const current = active ?? dates.length - 1;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = Math.max(0, current - 1);
    if (event.key === "ArrowRight") next = Math.min(dates.length - 1, current + 1);
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = dates.length - 1;
    if (event.key === "Escape") {
      setActive(null);
      return;
    }
    if (next !== null) {
      event.preventDefault();
      setActive(next);
    }
  }

  const activeValue = active === null ? null : (values[active] ?? null);
  const activePrevious = active === null || previous === null ? null : (previous[active] ?? null);
  const activeMemos = active === null ? [] : (marks.get(active) ?? []);
  const tipLeft = active === null ? 0 : Math.min(Math.max(x(active), 110), width - 110);
  const summary = summaryOf(label, dates, values, format);

  return (
    <div className={`trend trend-${tone}`}>
      <div
        ref={ref}
        className="trend-plot"
        tabIndex={0}
        role="group"
        aria-label={`${label}の推移。左右の矢印キーで日ごとの値を読めます`}
        onKeyDown={onKeyDown}
        onBlur={() => setActive(null)}
      >
        <svg width={width} height={height + LANE} role="img" aria-label={summary} className="trend-svg">
          <defs>
            <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" className="trend-hatch-bg" />
              <line x1="0" y1="0" x2="0" y2="6" className="trend-hatch-line" />
            </pattern>
            <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" className="trend-fill-top" />
              <stop offset="1" className="trend-fill-bottom" />
            </linearGradient>
          </defs>
          {domain.ticks.map((tick) => (
            <g key={tick} className="trend-grid">
              <line x1={MARGIN.left} x2={width - MARGIN.right} y1={y(tick)} y2={y(tick)} />
              <text x={MARGIN.left - 10} y={y(tick)} dy="0.35em" textAnchor="end">
                {format(tick)}
              </text>
            </g>
          ))}
          {dates.map((date, i) =>
            (i % labelEvery === 0 && dates.length - 1 - i >= labelEvery * 0.6) || i === dates.length - 1 ? (
              <text key={date} className="trend-xlabel" x={x(i)} y={base + 18} textAnchor="middle">
                {i === dates.length - 1 || i % labelEvery === 0 ? formatShortDate(date) : ""}
              </text>
            ) : null,
          )}
          {[...marks.keys()].map((i) => (
            <line key={`m${i}`} className="trend-memo-rule" x1={x(i)} x2={x(i)} y1={MARGIN.top} y2={base} />
          ))}
          {gapsOf(values).map(([from, to]) => (
            <g key={`gap${from}`} className="trend-gap">
              <rect
                x={x(from) - (dates.length > 1 ? step / 2 : 0)}
                y={MARGIN.top}
                width={Math.max(2, (to - from) * step + (dates.length > 1 ? step : 0))}
                height={plotHeight}
                fill={`url(#${hatchId})`}
              />
              {(to - from + 1) * step >= 40 && (
                <text x={(x(from) + x(to)) / 2} y={MARGIN.top + 14} textAnchor="middle">
                  データなし
                </text>
              )}
            </g>
          ))}
          {markers.map((marker) => {
            const i = dates.indexOf(marker.date);
            if (i === -1) return null;
            return (
              <g key={`mk${marker.date}`} className="trend-marker">
                <line x1={x(i)} x2={x(i)} y1={MARGIN.top} y2={base} />
                <text x={x(i) + 4} y={MARGIN.top + 10}>
                  {marker.label}
                </text>
              </g>
            );
          })}
          {!invert && <path className="trend-area" d={areaPath(values, x, y, base)} fill={`url(#${gradientId})`} />}
          {previous !== null && <path className="trend-previous" d={linePath(previous, x, y)} />}
          <path className="trend-line" d={linePath(values, x, y)} pathLength={1} />
          {active !== null && (
            <g className="trend-cursor">
              <line x1={x(active)} x2={x(active)} y1={MARGIN.top} y2={base} />
              {activePrevious !== null && <circle className="trend-dot-previous" cx={x(active)} cy={y(activePrevious)} r="3.5" />}
              {activeValue !== null && <circle className="trend-dot" cx={x(active)} cy={y(activeValue)} r="4.5" />}
            </g>
          )}
          <rect
            className="trend-hit"
            x={MARGIN.left - step / 2}
            y={0}
            width={plotWidth + step}
            height={base}
            onPointerMove={onPointerMove}
            onPointerLeave={() => setActive(null)}
          />
        </svg>
        {[...marks.entries()].map(([i, list]) => (
          <Link
            key={`pin${i}`}
            to={`/memos/${list[0]?.id ?? ""}`}
            className={list.some((memo) => memo.id === highlight) ? "trend-pin trend-pin-current" : "trend-pin"}
            title={list.map((memo) => memo.title).join("\n")}
            style={{ left: `${x(i)}px`, top: `${base + LANE - 16}px` }}
          >
            <span className="sr-only">
              {formatShortDate(dates[i] ?? "")} のメモ: {list.map((memo) => memo.title).join("、")}
            </span>
            {list.length > 1 && <span aria-hidden="true">{list.length}</span>}
          </Link>
        ))}
        {active !== null && (
          <div className="trend-tip" style={{ left: `${tipLeft}px` }} aria-live="polite">
            <p className="trend-tip-date">
              {formatShortDate(dates[active] ?? "")}（{weekday(dates[active] ?? "")}）
            </p>
            <p className="trend-tip-value">
              <span className="swatch swatch-current" aria-hidden="true" />
              {activeValue === null ? "データなし" : format(activeValue)}
            </p>
            {previousDates !== null && (
              <p className="trend-tip-previous">
                <span className="swatch swatch-previous" aria-hidden="true" />
                前の期間 {formatShortDate(previousDates[active] ?? "")}: {activePrevious === null ? "なし" : format(activePrevious)}
              </p>
            )}
            {activeMemos.length > 0 && (
              <ul className="trend-tip-memos">
                {activeMemos.map((memo) => (
                  <li key={memo.id}>{memo.title}</li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// The runs of days without a value, as [first, last] indexes. A run that touches either end is kept too.
function gapsOf(values: (number | null)[]): [number, number][] {
  const gaps: [number, number][] = [];
  let start: number | null = null;
  values.forEach((value, i) => {
    if (value === null && start === null) start = i;
    if (value !== null && start !== null) {
      gaps.push([start, i - 1]);
      start = null;
    }
  });
  if (start !== null) gaps.push([start, values.length - 1]);
  return gaps;
}

function summaryOf(label: string, dates: string[], values: (number | null)[], format: (value: number) => string): string {
  const numbers = values.filter((v): v is number => v !== null);
  if (numbers.length === 0 || dates.length === 0) return `${label}: データなし`;
  const first = numbers[0] ?? 0;
  const last = numbers[numbers.length - 1] ?? 0;
  return `${label} ${formatShortDate(dates[0] ?? "")}〜${formatShortDate(dates[dates.length - 1] ?? "")}: 最初 ${format(first)}・最後 ${format(last)}・最大 ${format(Math.max(...numbers))}`;
}

// A small line without axes: the period, and the previous period behind it.
export function Sparkline({
  values,
  previous,
  invert = false,
  tone,
}: {
  values: (number | null)[];
  previous?: (number | null)[] | null;
  invert?: boolean;
  tone: ChartTone;
}) {
  const width = 120;
  const height = 36;
  const all = [...values, ...(previous ?? [])].filter((v): v is number => v !== null);
  const min = invert ? Math.min(...all, Infinity) : 0;
  const max = Math.max(...all, 0);
  const span = max - min || 1;
  const x = (i: number) => (values.length > 1 ? (i / (values.length - 1)) * width : width / 2);
  const y = (v: number) => {
    const t = (v - (Number.isFinite(min) ? min : 0)) / span;
    return 3 + (invert ? t : 1 - t) * (height - 6);
  };
  return (
    <svg className={`spark spark-${tone}`} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      {previous != null && <path className="spark-previous" d={linePath(previous, x, y)} />}
      <path className="spark-line" d={linePath(values, x, y)} />
    </svg>
  );
}

// A row of a ranking: the label, the value and a bar of its share of the largest value.
export function BarRow({
  label,
  value,
  max,
  tone,
  title,
  children,
}: {
  label: React.ReactNode;
  value: number;
  max: number;
  tone: ChartTone;
  title?: string;
  children?: React.ReactNode;
}) {
  const share = max > 0 ? Math.max(0.01, value / max) : 0;
  return (
    <div className={`bar-row bar-${tone}`} title={title}>
      <span className="bar-fill" style={{ transform: `scaleX(${share})` }} aria-hidden="true" />
      <span className="bar-label">{label}</span>
      {children}
    </div>
  );
}

// The shares of the parts of a whole, side by side in one bar, with a legend.
export function ShareBar({ parts, format }: { parts: { label: string; value: number }[]; format: (value: number) => string }) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);
  if (total === 0) return null;
  return (
    <div className="share">
      <div className="share-bar" aria-hidden="true">
        {parts.map((part, i) => (
          <span key={part.label} className={`share-part share-${i % 6}`} style={{ flexGrow: part.value }} />
        ))}
      </div>
      <ul className="share-legend">
        {parts.map((part, i) => (
          <li key={part.label}>
            <span className={`swatch share-${i % 6}`} aria-hidden="true" />
            <span className="share-name">{part.label}</span>
            <span className="share-value">
              {format(part.value)}
              <span className="share-percent">{Math.round((part.value / total) * 1000) / 10}%</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
