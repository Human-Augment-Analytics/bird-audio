import { useEffect, useMemo, useState } from "react";
import type { FileRow, Progress, StartResult, Summary } from "../types";
import FileTable from "./FileTable";

interface Props {
  start: StartResult;
  progress: Progress | null;
  summary: Summary | null; // non-null once done
  rows: FileRow[];
  throughput: number; // files/sec
  onExport: (fmt: string, completeOnly: boolean) => void;
  onCancel: () => void;
}

/* Eased count-up for the completion stats — adds a beat of delight on finish. */
function useCountUp(target: number, run: boolean, duration = 1000) {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!run) { setVal(0); return; }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setVal(Math.round(target * eased));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, run, duration]);
  return val;
}

function Stat({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="stat">
      <span className="stat__label">{label}</span>
      <span className="stat__value" style={{ color: color ?? "var(--text)" }}>{value}</span>
    </div>
  );
}

const FILTERS: { key: "all" | "done" | "failed"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "done", label: "Complete" },
  { key: "failed", label: "Failed" },
];

export default function RunView({ start, progress, summary, rows, throughput, onExport, onCancel }: Props) {
  const [filter, setFilter] = useState<"all" | "done" | "failed">("all");
  const done = summary !== null;
  const total = progress?.total ?? summary?.total ?? start.total_files;
  const doneN = progress?.done ?? summary?.done ?? 0;
  const failedN = progress?.failed ?? summary?.failed ?? 0;
  const pendingN = progress?.pending ?? summary?.pending ?? 0;
  const inProg = progress?.in_progress ?? summary?.in_progress ?? 0;
  const pct = total > 0 ? Math.round(((doneN + failedN) / total) * 100) : 0;
  const eta = throughput > 0 ? Math.round(pendingN / throughput) : null;

  const nEvents = useCountUp(summary?.n_events ?? 0, done);
  const nComplete = useCountUp(summary?.n_complete ?? 0, done);
  const nRetained = useCountUp(summary?.n_retained ?? 0, done);

  const etaTime = useMemo(() => {
    if (!eta || eta <= 0) return null;
    const d = new Date();
    d.setSeconds(d.getSeconds() + eta);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }, [eta]);

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter]
  );

  return (
    <div className="card reveal" style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 24, display: "flex", alignItems: "center", gap: 12 }}>
          {!done && <span className="dot dot--ok" />}
          {done ? "Analysis complete" : "Listening to recordings…"}
        </h2>
        <span className="eyebrow">session {start.session_id} · {pct}%</span>
      </div>

      <div className={`progress ${done ? "progress--done" : ""}`}>
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="stats">
        <Stat label="Processed" value={doneN} color="var(--jade)" />
        <Stat label="Failed" value={failedN} color="var(--coral)" />
        <Stat label="Active" value={inProg} color="var(--amber)" />
        <Stat label="Remaining" value={pendingN} color="var(--text-dim)" />
        <Stat label="Total" value={total} />
        <Stat label="Speed" value={`${throughput.toFixed(1)}/s`} />
        <Stat label="ETA" value={etaTime || "—"} />
      </div>

      {!done && progress?.last_file && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ▸ {progress.last_file}
        </div>
      )}

      {done && summary && (
        <div className="summary">
          <div className="summary__cell">
            <div className="eyebrow">Detections found</div>
            <div className="summary__big" style={{ color: "var(--jade)" }}>{nEvents.toLocaleString()}</div>
          </div>
          <div className="summary__cell">
            <div className="eyebrow">High-quality buzzes</div>
            <div className="summary__big">{nComplete.toLocaleString()}</div>
          </div>
          <div className="summary__cell">
            <div className="eyebrow">Retained records</div>
            <div className="summary__big" style={{ color: "var(--text-dim)" }}>{nRetained.toLocaleString()}</div>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <span className="eyebrow" style={{ marginRight: 4 }}>Filter</span>
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? "primary" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {!done && <button onClick={onCancel}>Cancel run</button>}
        {done && (
          <>
            <button onClick={() => onExport("csv", false)}>Export CSV</button>
            <button onClick={() => onExport("csv", true)}>CSV · complete only</button>
            <button onClick={() => onExport("json", false)}>Export JSON</button>
          </>
        )}
      </div>

      <FileTable rows={filtered} />
    </div>
  );
}
