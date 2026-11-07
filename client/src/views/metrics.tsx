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
