// Numbers and dates for the dashboard. No JSX here, so that the tests can load it in Node.

const integer = new Intl.NumberFormat("ja-JP", { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat("ja-JP", { notation: "compact", maximumFractionDigits: 1 });

export function formatCount(value: number): string {
  return integer.format(value);
}

// For the axis of a chart: 12,000 as 1.2万.
export function formatAxis(value: number): string {
  return Math.abs(value) >= 10000 ? compact.format(value) : integer.format(value);
}

export function formatPercent(ratio: number, digits = 1): string {
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function formatPosition(value: number): string {
  return value.toFixed(1);
}

export type Change = { direction: "up" | "down" | "flat"; text: string; good: boolean | null };

// The change from previous to current. betterWhenLower: a fall is good (the search position). ratio: the change of a
// rate is shown in points, not percent of itself.
export function changeOf(
  current: number | null,
  previous: number | null,
  options: { betterWhenLower?: boolean; kind?: "relative" | "points" | "difference" } = {},
): Change | null {
  if (current === null || previous === null) return null;
  const kind = options.kind ?? "relative";
  let delta: number;
  let text: string;
  if (kind === "points") {
    delta = (current - previous) * 100;
    text = `${Math.abs(delta).toFixed(1)}pt`;
  } else if (kind === "difference") {
    delta = current - previous;
    text = Math.abs(delta).toFixed(1);
  } else {
    if (previous === 0) return current === 0 ? { direction: "flat", text: "±0%", good: null } : null;
    delta = ((current - previous) / previous) * 100;
    text = `${Math.abs(delta) >= 100 ? Math.round(Math.abs(delta)) : Math.abs(delta).toFixed(1)}%`;
  }
  if (Math.abs(delta) < 0.05) return { direction: "flat", text: kind === "relative" ? "±0%" : "±0", good: null };
  const direction = delta > 0 ? "up" : "down";
  const good = options.betterWhenLower === true ? direction === "down" : direction === "up";
  return { direction, text, good };
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

// "10/24" for 2026-10-24.
export function formatShortDate(date: string): string {
  if (date.length < 10) return date;
  return `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
}

// "2026/10/24".
export function formatDate(date: string): string {
  return date.replaceAll("-", "/");
}

export function weekday(date: string): string {
  if (date.length < 10) return "";
  const day = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))));
  return WEEKDAYS[day.getUTCDay()] ?? "";
}

// The date of a time in the browser's time zone, as YYYY-MM-DD.
export function localDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Every date from start to end, both included.
export function datesBetween(start: string, end: string): string[] {
  const out: string[] = [];
  const toTime = (date: string) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  for (let t = toTime(start), last = toTime(end); t <= last; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

// The URL without the scheme and the site's own origin, for lists: "https://cyfr.dev/blog/a" as "/blog/a".
export function shortUrl(url: string, origin: string | null): string {
  try {
    const parsed = new URL(url);
    if (origin !== null && parsed.origin === new URL(origin).origin) return `${parsed.pathname}${parsed.search}` || "/";
    return `${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

// The date n days after date (before it when n is negative).
export function addDays(date: string, n: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return new Date(t + n * 86400000).toISOString().slice(0, 10);
}
