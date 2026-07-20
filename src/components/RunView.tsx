import { useEffect, useMemo, useState } from "react";
import type { FileDone, FileRow, Progress, StartResult, Summary, ExportedEvent } from "../types";
import { pickFile, getSessionEvents } from "../api";
import SanityCheckViews from "./SanityCheckViews";
import { FolderTree } from "./FolderTree";
import { buildTree, countFiles } from "../pathTree";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "Listening",
  done: "Complete",
  failed: "Failed",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "var(--text-faint)",
  in_progress: "var(--amber)",
  done: "var(--jade)",
  failed: "var(--coral)",
};

interface Props {
  start: StartResult;
  progress: Progress | null;
  summary: Summary | null; // non-null once done
  rows: FileRow[];
  activity: FileDone[]; // newest-first per-file "stored"/failed/retry log
  throughput: number; // files/sec
  onExport: (fmt: string, completeOnly: boolean, confirmedOnly: boolean, metadataPath: string | null) => void;
  onCancel: () => void;
  onRetryFailed: () => void;
  /** Retry one failed recording. Omitted when the `row_retry` flag is off. */
  onRetryFile?: (path: string) => void;
  outputDir: string;
  inputDir: string;
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

export default function RunView({ start, progress, summary, rows, activity, throughput, onExport, onCancel, onRetryFailed, onRetryFile, outputDir, inputDir }: Props) {
  const [filter, setFilter] = useState<"all" | "done" | "failed">("all");
  const [metadataPath, setMetadataPath] = useState<string | null>(null);
  const [exportFormat, setExportFormat] = useState<string>("csv");
  const [exportCompleteOnly, setExportCompleteOnly] = useState<boolean>(false);
  const [exportConfirmedOnly, setExportConfirmedOnly] = useState<boolean>(false);
  const [events, setEvents] = useState<ExportedEvent[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const done = summary !== null;

  useEffect(() => {
    if (done && start.session_id) {
      setLoadingEvents(true);
      getSessionEvents(outputDir, start.session_id)
        .then((evs) => {
          setEvents(evs);
          setLoadingEvents(false);
        })
        .catch((err) => {
          console.error("Failed to load session events:", err);
          setLoadError(String(err));
          setLoadingEvents(false);
        });
    } else {
      setEvents([]);
    }
  }, [done, start.session_id, outputDir]);
  const total = progress?.total ?? summary?.total ?? start.total_files;
  const doneN = progress?.done ?? summary?.done ?? 0;
  const failedN = progress?.failed ?? summary?.failed ?? 0;
  const pendingN = progress?.pending ?? summary?.pending ?? 0;
  const inProg = progress?.in_progress ?? summary?.in_progress ?? 0;
  const pct = total > 0 ? Math.round(((doneN + failedN) / total) * 100) : 0;
  const eta = throughput > 0 ? Math.round(pendingN / throughput) : null;
  const lastMs = progress?.last_elapsed_ms ?? null;
  const elapsedTotalMs = progress?.elapsed_ms_total ?? null;

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

  // Group the filtered recordings by their folder structure so it's clear which
  // folder each file came from — collapsible, just like the Review page.
  const tree = useMemo(() => buildTree(filtered, inputDir), [filtered, inputDir]);

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
          {!done && <span className="dot dot--ok" />}
          {done ? "Analysis complete" : "Listening to recordings…"}
        </h2>
        <span className="eyebrow">session {start.session_id} · {pct}%</span>
      </div>

      <div className={`progress ${done ? "progress--done" : ""}`}>
        <div className="progress__fill" style={{ width: `${pct}%` }} />
      </div>

      {!done && (
        <div className="sub" style={{ fontSize: 12.5 }}>
          {doneN + failedN} of {total} recordings finished
          {eta && etaTime ? <> · about {eta < 60 ? "a minute" : `${Math.round(eta / 60)} min`} left — should finish around {etaTime}</> : <> · estimating time remaining…</>}
        </div>
      )}

      <div className="stats">
        <Stat label="Processed" value={doneN} color="var(--jade)" />
        <Stat label="Failed" value={failedN} color="var(--coral)" />
        <Stat label="Active" value={inProg} color="var(--amber)" />
        <Stat label="Remaining" value={pendingN} color="var(--text-dim)" />
        <Stat label="Total" value={total} />
        <Stat label="Speed" value={`${throughput.toFixed(1)}/s`} />
        <Stat label="Last (ms)" value={lastMs !== null ? String(lastMs) : "—"} />
        <Stat label="Elapsed" value={elapsedTotalMs != null ? `${Math.round(elapsedTotalMs / 1000)}s` : "—"} />
        <Stat label="ETA" value={etaTime || "—"} />
      </div>

      {!done && progress?.last_file && (
        <div className="mono" style={{ fontSize: 11.5, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          ▸ {progress.last_file}
        </div>
      )}

      {activity.length > 0 && (
        <div className="activity-log" style={{ display: "grid", gap: 3, maxHeight: 132, overflow: "auto", padding: "10px 12px", background: "rgba(255,255,255,0.015)", border: "1px solid var(--line)", borderRadius: 8 }}>
          <span className="eyebrow" style={{ marginBottom: 2 }}>Activity</span>
          {activity.map((f, i) => {
            const name = f.path.split("/").pop() || f.path;
            const color = f.status === "done" ? "var(--jade)" : f.status === "retry" ? "var(--amber)" : "var(--coral)";
            const mark = f.status === "done" ? "✓" : f.status === "retry" ? "↻" : "✕";
            const msg = f.status === "done"
              ? `${f.n_events} ${f.n_events === 1 ? "buzz" : "buzzes"} · saved`
              : f.status === "retry"
                ? `error — retrying (attempt ${f.attempt}/${f.max_attempts})`
                : `failed${f.error ? ` — ${f.error}` : ""}`;
            return (
              <div key={`${f.path}-${i}`} className="mono" style={{ fontSize: 11, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                <span style={{ color, fontWeight: 700, marginRight: 6 }}>{mark}</span>
                <span style={{ color: "var(--text)" }}>{name}</span>
                <span style={{ color: "var(--text-faint)" }}> — {msg}</span>
              </div>
            );
          })}
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

      {done && (
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

      {done && !loadingEvents && !loadError && events.length > 0 && (
        <SanityCheckViews events={events} />
      )}

      {done && loadingEvents && (
        <div className="card" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, padding: 32, textAlign: "center", color: "var(--text-dim)", background: "var(--surface)", borderRadius: "var(--radius)", border: "1px solid var(--line)", boxShadow: "var(--shadow)" }}>
          <div className="loading-spinner" />
          <div style={{ fontSize: "11px", fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>LOADING DIAGNOSTIC EVENTS…</div>
        </div>
      )}

      {done && loadError && (
        <div className="card" style={{ padding: 20, textAlign: "center", color: "var(--coral)" }}>
          Failed to load diagnostics: {loadError}
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
        {done && failedN > 0 && (
          <button className="primary" style={{ borderColor: "var(--coral)" }} onClick={onRetryFailed}>
            ↻ Retry failed ({failedN})
          </button>
        )}
        {!done && <button onClick={onCancel}>Cancel run</button>}
      </div>

      <div className="tablewrap" style={{ height: 420, overflow: "auto" }}>
        {filtered.length === 0 ? (
          <div className="empty">No recordings to show in this view yet.</div>
        ) : (
          <FolderTree
            root={tree}
            leafKey={(r) => r.path}
            renderFolderMeta={(node) => (
              <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--text-faint)", flex: "none" }}>{countFiles(node)}</span>
            )}
            renderLeaf={(r) => {
              const color = STATUS_COLORS[r.status] ?? "var(--text)";
              const basename = r.path.split("/").pop() || r.path;
              return (
                <div className="trow" style={{ height: 34 }}>
                  <span className="status-pill" style={{ width: 96, color }}>
                    <span className="dot" style={{ background: color }} />
                    {STATUS_LABELS[r.status] ?? r.status}
                  </span>
                  <span className="trow__name" title={r.path}>{basename}</span>
                  <span className="trow__count" style={{ width: 96 }}>
                    {r.n_events} {r.n_events === 1 ? "buzz" : "buzzes"}
                  </span>
                  {r.error && (
                    <span className="trow__err" style={{ width: 200 }} title={r.error}>
                      {r.error}
                    </span>
                  )}
                  {done && r.status === "failed" && onRetryFile && (
                    <button
                      className="chip"
                      style={{ color: "var(--coral)", padding: "1px 7px", fontSize: 11 }}
                      title={`Retry just ${basename}`}
                      onClick={(e) => { e.stopPropagation(); onRetryFile(r.path); }}
                    >
                      ↻
                    </button>
                  )}
                </div>
              );
            }}
          />
        )}
      </div>
    </div>
  );
}
