import type { InsightsCoverage } from "../../../src/api/types";
import { Link } from "../Link";
import type { Change } from "../numbers";
import { type ChartTone, Sparkline } from "./charts";

// The change from the previous period: an arrow, the size, and a color for better or worse.
export function Delta({ change, label = "前の期間から" }: { change: Change | null; label?: string }) {
  if (change === null) return null;
  const arrow = change.direction === "up" ? "↑" : change.direction === "down" ? "↓" : "→";
  const verdict = change.good === null ? "flat" : change.good ? "good" : "bad";
  const spoken = change.direction === "up" ? "増加" : change.direction === "down" ? "減少" : "変化なし";
  return (
    <span className={`delta delta-${verdict}`}>
      <span aria-hidden="true">{arrow}</span>
      {change.text}
      <span className="sr-only">
        （{label}
        {spoken}）
      </span>
    </span>
  );
}

// One figure of the period: its value, the change, and a small line. Pressing it shows it on the main chart.
export function KpiButton({
  label,
  value,
  change,
  values,
  previous,
  tone,
  invert,
  selected,
  onSelect,
  note,
}: {
  label: string;
  value: string;
  change: Change | null;
  values: (number | null)[];
  previous: (number | null)[] | null;
  tone: ChartTone;
  invert?: boolean;
  selected: boolean;
  onSelect: () => void;
  note?: string;
}) {
  return (
    <button type="button" className={`kpi kpi-${tone}`} aria-pressed={selected} onClick={onSelect}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-foot">
        <Delta change={change} />
        {note !== undefined && <span className="kpi-note">{note}</span>}
      </span>
      <Sparkline values={values} previous={previous} tone={tone} invert={invert} />
    </button>
  );
}

// The state of the data of one source for the period: the imported days, the provisional ones, the days waiting for
// their import and the missing ones (not imported and not waiting: failed or never imported). Only missing days warn;
// the days waiting are shown in a neutral color.
export function FreshnessItem({ label, coverage, siteId }: { label: string; coverage: InsightsCoverage; siteId: string }) {
  const pending = coverage.pending_days;
  const missing = coverage.missing_days - pending;
  return (
    <li className={missing > 0 ? "freshness-warn" : pending > 0 ? "freshness-pending" : undefined}>
      <span className="freshness-source">{label}</span>
      <span>
        {coverage.available_days}/{coverage.days} 日
      </span>
      {coverage.provisional_days > 0 && <span>直近 {coverage.provisional_days} 日は速報値</span>}
      {pending > 0 && (
        <Link to={`/sites/${siteId}/data`} className="freshness-link freshness-link-pending">
          取得待ち {pending} 日
        </Link>
      )}
      {missing > 0 && (
        <Link to={`/sites/${siteId}/data`} className="freshness-link">
          欠損 {missing} 日
        </Link>
      )}
    </li>
  );
}
