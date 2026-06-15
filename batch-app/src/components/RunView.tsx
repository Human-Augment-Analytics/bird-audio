import { useMemo, useState } from "react";
import { cancelSession } from "../api";
import type { FileRow, Progress, StartResult, Summary } from "../types";
import FileTable from "./FileTable";

interface Props {
  start: StartResult;
  progress: Progress | null;
  summary: Summary | null; // non-null once done
  rows: FileRow[];
  throughput: number; // files/sec
  onExport: (fmt: string, completeOnly: boolean) => void;
}

function Tile({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div style={{ display: "grid", gap: 2 }}>
      <span style={{ color: "#9aa0aa", fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 18, color: color ?? "#e6e7ea" }}>{value}</span>
    </div>
  );
}

export default function RunView({ start, progress, summary, rows, throughput, onExport }: Props) {
  const [filter, setFilter] = useState<"all" | "done" | "failed">("all");
  const done = summary !== null;
  const total = progress?.total ?? summary?.total ?? start.total_files;
  const doneN = progress?.done ?? summary?.done ?? 0;
  const failedN = progress?.failed ?? summary?.failed ?? 0;
  const pendingN = progress?.pending ?? summary?.pending ?? 0;
  const inProg = progress?.in_progress ?? summary?.in_progress ?? 0;
  const pct = total > 0 ? Math.round(((doneN + failedN) / total) * 100) : 0;
  const eta = throughput > 0 ? Math.round(pendingN / throughput) : null;

  const filtered = useMemo(
    () => (filter === "all" ? rows : rows.filter((r) => r.status === filter)),
    [rows, filter]
  );

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <h2>
        {done ? "Session complete" : "Running…"} (session {start.session_id})
      </h2>
      <div style={{ height: 14, background: "#1f2228", borderRadius: 7, overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: done ? "#34d399" : "#3b82f6" }} />
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        <Tile label="Done" value={doneN} color="#34d399" />
        <Tile label="Failed" value={failedN} color="#f87171" />
        <Tile label="Running" value={inProg} color="#fbbf24" />
        <Tile label="Pending" value={pendingN} color="#9aa0aa" />
        <Tile label="Total" value={total} />
        <Tile label="Throughput" value={`${throughput.toFixed(2)}/s`} />
        <Tile label="ETA" value={eta === null ? "—" : `${eta}s`} />
      </div>
      {done && summary && (
        <div style={{ fontSize: 13, color: "#9aa0aa" }}>
          {summary.n_events} events · {summary.n_complete} complete · {summary.n_retained} retained
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
        {!done && <button onClick={() => cancelSession()}>Cancel</button>}
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
