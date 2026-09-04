import { useMemo, useState } from "react";
import type { FileRow, Progress, StartResult, Summary } from "../types";
import FileTable from "./FileTable";
import { pickFile } from "../api";

interface Props {
  start: StartResult;
  progress: Progress | null;
  summary: Summary | null; // non-null once done
  rows: FileRow[];
  throughput: number; // files/sec
  onExport: (fmt: string, completeOnly: boolean, confirmedOnly: boolean, metadataPath: string | null) => void;
  onCancel: () => void;
  cancelled: boolean;
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

export default function RunView({ start, progress, summary, rows, throughput, onExport, onCancel, cancelled }: Props) {
  const [filter, setFilter] = useState<"all" | "done" | "failed">("all");
  const [metadataPath, setMetadataPath] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<string>("csv");
  const [exportCompleteOnly, setExportCompleteOnly] = useState<boolean>(false);
  const [exportConfirmedOnly, setExportConfirmedOnly] = useState<boolean>(false);
  const done = summary !== null;
  const completed = summary?.status === "done";
  const failed = summary?.status === "failed";
  const doneN = summary?.done ?? progress?.done ?? rows.filter((r) => r.status === "done").length;
  const hasCompletedFiles = done || doneN > 0;
  const total = summary?.total ?? progress?.total ?? start.total_files;
  const failedN = summary?.failed ?? progress?.failed ?? 0;
  // Progress events only fire when a file finishes, so between files the snapshot says
  // "0 active / N pending" while a worker is already busy. Rows are polled every second
  // and reflect the claimed file, so prefer them while the run is live.
  const rowsLoaded = rows.length > 0;
  const pendingN = summary?.pending ?? (rowsLoaded ? rows.filter((r) => r.status === "pending").length : progress?.pending ?? 0);
  const inProg = summary?.in_progress ?? (rowsLoaded ? rows.filter((r) => r.status === "in_progress").length : progress?.in_progress ?? 0);
  const pct = total > 0 ? Math.round(((doneN + failedN) / total) * 100) : 0;
  const remainingN = pendingN + inProg;
  const eta = throughput > 0 && remainingN > 0 ? Math.round(remainingN / throughput) : null;
  const lastMs = progress?.last_elapsed_ms ?? null;
  const elapsedTotalMs = progress?.elapsed_ms_total ?? null;

  const nEvents = summary?.n_events ?? rows.reduce((acc, r) => acc + (r.n_events || 0), 0);
  const nComplete = summary?.n_complete ?? rows.reduce((acc, r) => acc + (r.n_complete || 0), 0);
  const nRetained = summary?.n_retained ?? rows.reduce((acc, r) => acc + (r.n_retained || 0), 0);

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

  const handlePickMetadata = async () => {
    try {
      const file = await pickFile([{ name: "CSV Metadata", extensions: ["csv"] }]);
      if (file) {
        setMetadataPath(file);
      }
    } catch (e) {
      console.error(e);
    }
  };

  const handleClearMetadata = () => {
    setMetadataPath(null);
  };

  return (
    <div className="card reveal" style={{ display: "grid", gap: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 14, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 24, display: "flex", alignItems: "center", gap: 12 }}>
          {!done && <span className={`dot ${cancelled ? "dot--bad" : "dot--ok"}`} />}
          {completed ? "Analysis complete" : failed ? "Analysis completed with file failures" :
            done || cancelled ? (done ? "Analysis cancelled" : "Cancelling analysis…") : "Listening to recordings…"}
        </h2>
        <span className="eyebrow">session {start.session_id} · {pct}%</span>
      </div>

      <div className={`progress ${completed ? "progress--done" : ""}`}>
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>

      <div className="stats">
        <Stat label="Processed" value={doneN} color="var(--jade)" />
        <Stat label="Failed" value={failedN} color="var(--coral)" />
        <Stat label="Active" value={inProg} color="var(--amber)" />
        <Stat label="Remaining" value={pendingN} color="var(--text-dim)" />
        <Stat label="Total" value={total} />
        <Stat label="Speed" value={throughput > 0 ? `${(throughput * 60).toFixed(1)}/min` : "—"} />
        <Stat label="Last (ms)" value={lastMs !== null ? String(lastMs) : "—"} />
        <Stat label="Elapsed" value={elapsedTotalMs != null ? `${Math.round(elapsedTotalMs / 1000)}s` : "—"} />
        <Stat label="ETA" value={etaTime || "—"} />
      </div>

      {!done && progress?.last_file && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ▸ {progress.last_file}
        </div>
      )}

      {hasCompletedFiles && (
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

      {hasCompletedFiles && (
        <div className="card" style={{ border: "1px solid rgba(255, 255, 255, 0.08)", borderRadius: 10, padding: "16px 20px", background: "rgba(255, 255, 255, 0.01)", display: "grid", gap: 14 }}>
          <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>Export Options</h3>
          
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 18 }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="eyebrow">Deployment Metadata</span>
              {metadataPath ? (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "8px 12px", background: "rgba(255, 255, 255, 0.04)", borderRadius: 6, fontSize: 12.5 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={metadataPath}>
                    📄 {metadataPath.split("/").pop()}
                  </span>
                  <button 
                    onClick={handleClearMetadata} 
                    style={{ background: "none", border: "none", color: "var(--coral)", cursor: "pointer", padding: "0 4px", fontSize: 14, fontWeight: "bold" }}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <button className="chip" onClick={handlePickMetadata} style={{ alignSelf: "flex-start", padding: "8px 12px", border: "1px dashed rgba(255,255,255,0.2)" }}>
                  ＋ Select Metadata CSV
                </button>
              )}
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
                Matches audio file device (e.g. PSL2, H1) to append site info & export per-site summary.
              </span>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <span className="eyebrow">Format & Filter</span>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {[
                  { key: "csv", label: "CSV" },
                  { key: "json", label: "JSON" },
                  { key: "warbler", label: "warbleR CSV" },
                  { key: "raven", label: "Raven Table" },
                ].map((f) => (
                  <button
                    key={f.key}
                    className={`chip ${exportFormat === f.key ? "primary" : ""}`}
                    onClick={() => setExportFormat(f.key)}
                  >
                    {f.label}
                  </button>
                ))}
              </div>
              
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: "pointer", marginTop: 6, color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={exportCompleteOnly}
                  onChange={(e) => setExportCompleteOnly(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <span>Complete events only</span>
              </label>

              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, cursor: "pointer", marginTop: 4, color: "var(--text-dim)" }}>
                <input
                  type="checkbox"
                  checked={exportConfirmedOnly}
                  onChange={(e) => setExportConfirmedOnly(e.target.checked)}
                  style={{ cursor: "pointer" }}
                />
                <span>Confirmed events only</span>
              </label>
            </div>
          </div>

          <div style={{ display: "flex", justifyContent: "flex-end", borderTop: "1px solid rgba(255, 255, 255, 0.05)", paddingTop: 12 }}>
            <button
              className="primary"
              style={{ padding: "8px 18px", fontSize: 13.5, fontWeight: 600 }}
              onClick={() => onExport(exportFormat, exportCompleteOnly, exportConfirmedOnly, metadataPath)}
            >
              Export Session Detections
            </button>
          </div>
        </div>
      )}

      <div className="filter-bar">
        <span className="eyebrow" style={{ marginRight: 4 }}>Filter View</span>
        {FILTERS.map((f) => (
          <button key={f.key} className={`chip ${filter === f.key ? "primary" : ""}`} onClick={() => setFilter(f.key)}>
            {f.label}
          </button>
        ))}
        <span style={{ flex: 1 }} />
        {!done && <button onClick={onCancel} disabled={cancelled}>{cancelled ? "Cancelling…" : "Cancel run"}</button>}
      </div>

      <FileTable rows={filtered} />
    </div>
  );
}
