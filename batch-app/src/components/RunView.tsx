import { useMemo, useState } from "react";
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

function Tile({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ color: "#9aa0aa", fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 18, color: color ?? "#e6e7ea" }}>{value}</span>
    </div>
  );
}

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
    <div className="card" style={{ display: "grid", gap: 14 }}>
      <h2 style={{ fontSize: 20, margin: "8px 0" }}>
        {done ? "Analysis complete" : "Processing recordings…"} 
        <span style={{ fontSize: 13, color: "#9aa0aa", fontWeight: 400, marginLeft: 12 }}>
          ID: {start.session_id}
        </span>
      </h2>
      <div style={{ height: 10, background: "#1f2228", borderRadius: 5, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: done ? "#10b981" : "#3b82f6", transition: "width 0.3s ease" }} />
      </div>
      <div style={{ display: "flex", gap: 24, flexWrap: "wrap", padding: "8px 0" }}>
        <Tile label="Processed" value={doneN} color="#10b981" />
        <Tile label="Failed" value={failedN} color="#f87171" />
        <Tile label="Active" value={inProg} color="#fbbf24" />
        <Tile label="Remaining" value={pendingN} color="#9aa0aa" />
        <Tile label="Total Files" value={total} />
        <Tile label="Processing Speed" value={`${throughput.toFixed(2)} files/s`} />
        <Tile label="Completion ETA" value={etaTime || "—"} />
      </div>
      {!done && progress?.last_file && (
        <div style={{ fontSize: 12, color: "#9aa0aa", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontStyle: "italic" }}>
          Current: {progress.last_file}
        </div>
      )}
      {done && summary && (
        <div style={{ 
          display: "flex", gap: 32, padding: 20, borderRadius: 12, 
          background: "rgba(52, 211, 153, 0.05)", border: "1px solid rgba(52, 211, 153, 0.1)",
          margin: "8px 0"
        }}>
          <div>
            <div style={{ fontSize: 11, color: "#9aa0aa", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Detections Found</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#10b981" }}>{summary.n_events}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#9aa0aa", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>High-Quality Buzzes</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#e6e7ea" }}>{summary.n_complete}</div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#9aa0aa", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 4 }}>Retained Records</div>
            <div style={{ fontSize: 24, fontWeight: 700, color: "#9aa0aa" }}>{summary.n_retained}</div>
          </div>
        </div>
      )}
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span style={{ fontSize: 13, color: "#9aa0aa" }}>Filter:</span>
        {(["all", "done", "failed"] as const).map((f) => (
          <button key={f} className={filter === f ? "primary" : ""} onClick={() => setFilter(f)}>
            {f}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {!done && <button onClick={onCancel}>Cancel</button>}
        {done && (
          <>
            <button onClick={() => onExport("csv", false)}>Export CSV</button>
            <button onClick={() => onExport("csv", true)}>CSV (complete only)</button>
            <button onClick={() => onExport("json", false)}>Export JSON</button>
          </>
        )}
      </div>
      <FileTable rows={filtered} />
    </div>
  );
}
