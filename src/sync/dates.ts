// Calendar dates as YYYY-MM-DD strings, shared by the import and the reads.

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

// Whether value is a YYYY-MM-DD string of a date that exists.
export function isValidDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const time = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return new Date(time).toISOString().slice(0, 10) === value;
}

function toTime(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
}

function fromTime(time: number): string {
  return new Date(time).toISOString().slice(0, 10);
}

// The date n days after date (before it when n is negative).
export function addDays(date: string, n: number): string {
  return fromTime(toTime(date) + n * DAY_MS);
}

// The number of days from start to end, both included.
export function daysBetween(start: string, end: string): number {
  return Math.round((toTime(end) - toTime(start)) / DAY_MS) + 1;
}

// Every date from start to end, both included.
export function datesBetween(start: string, end: string): string[] {
  const dates: string[] = [];
  for (let time = toTime(start), last = toTime(end); time <= last; time += DAY_MS) dates.push(fromTime(time));
  return dates;
}

// Today in UTC.
export function todayUtc(now: number): string {
  return fromTime(now);
}

// The date n calendar months before date. A day that the month does not have becomes its last day.
export function subtractMonths(date: string, n: number): string {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7)) - 1 - n;
  const day = Number(date.slice(8, 10));
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return fromTime(Date.UTC(year, month, Math.min(day, lastDay)));
}

// Whether timeZone is an IANA time zone that Intl accepts.
export function isUsableTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone === "") return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone });
    return true;
  } catch {
    return false;
  }
}

// Today in timeZone, which must be usable (isUsableTimeZone).
export function todayIn(timeZone: string, now: number): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
