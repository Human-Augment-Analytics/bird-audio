import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CachedFile, EventRow, FileRow, StartOpts, StartResult } from "../types";
import {
  addManualEvent, audioSrc, clearCache, deleteCachedFiles, deleteEvent, getCachedFiles, listEvents,
  prepareReview, setEventReview, updateEventBounds,
} from "../api";
import { AudioVisualizer } from "./AudioVisualizer";
import { EventTable } from "./EventTable";
import { STAGE_COLOR, STAGE_LABEL } from "../stageMeta";
import { findDeviceId } from "../deviceId";
import { FolderTree } from "./FolderTree";
import { buildTree, countFiles, relativePath } from "../pathTree";

type StageFilter = "all" | CachedFile["stage"];
type Mode = "browse" | "select";

export interface ReviewViewProps {
  start: StartResult;
  opts: StartOpts;
  rows: FileRow[];
  /** When provided, the sidebar can switch into a "select which cached files
   * to use" mode; clicking Next there applies the selection and calls this,
   * which the parent uses to jump back to the Analyze tab ready to run. Only
   * meaningful before a session has actually started running. */
  onProceedToAnalyze?: () => void;
}

export default function ReviewView({ start, opts, rows, onProceedToAnalyze }: ReviewViewProps) {
  const sid = start.session_id;
  const dir = opts.outputDir;

  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [cachedFiles, setCachedFiles] = useState<CachedFile[]>([]);
  const [stageFilter, setStageFilter] = useState<StageFilter>("all");
  const currentPathRef = useRef<string | null>(null);

  const [mode, setMode] = useState<Mode>("browse");
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    prepareReview(dir, sid).catch((e) => { if (!cancelled) setPrepareError(String(e)); });
    return () => { cancelled = true; };
  }, [dir, sid]);

  useEffect(() => {
    let cancelled = false;
    getCachedFiles(dir).then((files) => {
      if (cancelled) return;
      setCachedFiles(files);
      // Checked = "use this cached result" — start with everything checked
      // so doing nothing and clicking Next reuses the cache exactly as-is.
      setSelectedFiles(new Set(files.map((f) => f.path)));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [dir]);

  const stageByPath = useMemo(() => {
    const map: Record<string, CachedFile> = {};
    for (const f of cachedFiles) map[f.path] = f;
    return map;
  }, [cachedFiles]);

  const fetchEvents = useCallback(async (path: string, showLoading = false) => {
    currentPathRef.current = path;
    if (showLoading) {
      setLoadingEvents(true);
    }
    try {
      const result = await listEvents(dir, sid, path);
      if (currentPathRef.current === path) setEvents(result);
    } catch (e) {
      if (currentPathRef.current === path) setNotice(`Failed to load events: ${String(e)}`);
    } finally {
      if (currentPathRef.current === path && showLoading) {
        setLoadingEvents(false);
      }
    }
  }, [dir, sid]);

  const refreshEvents = useCallback(async () => {
    if (selectedPath) await fetchEvents(selectedPath, false);
  }, [selectedPath, fetchEvents]);

  const selectFile = useCallback((path: string) => {
    if (path === selectedPath) return;
    setSelectedPath(path); setSelectedId(null); setEvents([]); setNotice(null);
    fetchEvents(path, true);
  }, [selectedPath, fetchEvents]);

  const currentStatus = useCallback(
    (id: number): "unreviewed" | "confirmed" | "rejected" =>
      events.find((e) => e.id === id)?.review_status ?? "unreviewed",
    [events]);

  const handleSelectEvent = useCallback((id: number) => setSelectedId(id), []);
  const handleSetReview = useCallback(async (id: number, status: "confirmed" | "rejected" | "unreviewed") => {
    try { await setEventReview(dir, id, status); await refreshEvents(); }
    catch (e) { setNotice(`Review update failed: ${String(e)}`); }
  }, [dir, refreshEvents]);
  const handleUpdateBounds = useCallback(async (id: number, t_start: number, t_end: number, f_low: number, f_high: number) => {
    try { await updateEventBounds(dir, id, t_start, t_end, f_low, f_high); await refreshEvents(); }
    catch (e) { setNotice(`Bounds update failed: ${String(e)}`); }
  }, [dir, refreshEvents]);
  const handleAddEvent = useCallback(async (e: { t_start: number; t_end: number; f_low: number; f_high: number }) => {
    if (!selectedPath) return;
    try {
      const newId = await addManualEvent(dir, sid, selectedPath, { tStart: e.t_start, tEnd: e.t_end, fLow: e.f_low, fHigh: e.f_high });
      await refreshEvents(); setSelectedId(newId);
    } catch (err) { setNotice(`Add event failed: ${String(err)}`); }
  }, [dir, sid, selectedPath, refreshEvents]);
  const handleDelete = useCallback(async (id: number) => {
    try { await deleteEvent(dir, id); if (selectedId === id) setSelectedId(null); await refreshEvents(); }
    catch (e) { setNotice(`Delete failed: ${String(e)}`); }
  }, [dir, selectedId, refreshEvents]);
  const handleEditLabelNote = useCallback(async (id: number, label: string, note: string) => {
    try { await setEventReview(dir, id, currentStatus(id), label, note); await refreshEvents(); }
    catch (e) { setNotice(`Label/note update failed: ${String(e)}`); }
  }, [dir, currentStatus, refreshEvents]);

  const src = selectedPath ? audioSrc(selectedPath) : null;
  const selectedDevice = selectedPath ? findDeviceId(selectedPath) : null;

  const MAX_VISIBLE = 150;

  const { doneRows, visibleRows, isTruncated, stageCounts } = useMemo(() => {
    const done = rows.filter((r) => r.status === "done");
    const counts = { pending: 0, stage_a: 0, complete: 0 };
    for (const r of done) {
      const stage = stageByPath[r.path]?.stage;
      if (stage) counts[stage]++;
    }
    const filtered = done
      .filter((r) => stageFilter === "all" || stageByPath[r.path]?.stage === stageFilter)
      .filter((r) => {
        const basename = r.path.split("/").pop() || r.path;
        return basename.toLowerCase().includes(searchQuery.toLowerCase());
      });
    return {
      doneRows: done,
      visibleRows: filtered.slice(0, MAX_VISIBLE),
      isTruncated: filtered.length > MAX_VISIBLE,
      stageCounts: counts,
    };
  }, [rows, searchQuery, stageByPath, stageFilter]);

  // Jump straight to the first available recording instead of showing an
  // empty "select a recording" page — most useful coming from a "jump to
  // cached results" entry point where nothing has been clicked yet.
  useEffect(() => {
    if (!selectedPath && visibleRows.length > 0) {
      selectFile(visibleRows[0].path);
    }
  }, [selectedPath, visibleRows, selectFile]);

  const browseTree = useMemo(() => buildTree(visibleRows, opts.input), [visibleRows, opts.input]);
  const selectTree = useMemo(() => buildTree(cachedFiles, opts.input), [cachedFiles, opts.input]);

  const brokenCount = cachedFiles.filter((f) => f.broken).length;
  const stageACount = cachedFiles.filter((f) => f.stage === "stage_a").length;
  const excludedCount = cachedFiles.length - selectedFiles.size;

  const toggleFileSelected = (path: string) =>
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const selectAllFiles = () => setSelectedFiles(new Set(cachedFiles.map((f) => f.path)));
  const selectNoFiles = () => setSelectedFiles(new Set());
  const excludeBroken = () => setSelectedFiles(new Set(cachedFiles.filter((f) => !f.broken).map((f) => f.path)));
  const excludeStageAOnly = () => setSelectedFiles(new Set(cachedFiles.filter((f) => f.stage !== "stage_a").map((f) => f.path)));

  const handleNext = async () => {
    if (!onProceedToAnalyze) return;
    setApplying(true);
    try {
      const toClear = cachedFiles.filter((f) => !selectedFiles.has(f.path)).map((f) => f.path);
      if (toClear.length > 0) {
        if (selectedFiles.size === 0) await clearCache(dir);
        else await deleteCachedFiles(dir, toClear);
      }
      onProceedToAnalyze();
    } catch (e) {
      setNotice(`Couldn't apply selection: ${String(e)}`);
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="reveal" style={{ display: "grid", gridTemplateColumns: "264px 1fr", gap: 0,
      minHeight: 520, border: "1px solid var(--line)", borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow)" }}>
      <aside style={{ borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
        <div style={{ padding: "11px 13px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-faint)" }}>
            {mode === "browse" ? "RECORDINGS" : "CHOOSE FILES"}
          </span>
          {mode === "browse" ? (
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>{doneRows.length}/{rows.length}</span>
          ) : (
            <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>{selectedFiles.size}/{cachedFiles.length}</span>
          )}
        </div>

        {onProceedToAnalyze && (
          <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
            <button
              className={mode === "browse" ? "chip primary" : "chip"}
              style={{
                width: "100%",
                justifyContent: "center",
                ...(mode === "browse"
                  ? { color: "#1a1206", fontWeight: 700, boxShadow: "0 1px 6px var(--amber-soft)" }
                  : { color: "var(--amber)", background: "var(--amber-soft)", border: "1px solid var(--amber)" }),
              }}
              onClick={() => setMode((m) => (m === "browse" ? "select" : "browse"))}
            >
              {mode === "browse" ? "Select cached files to use →" : "← Back to review"}
            </button>
          </div>
        )}

        {mode === "browse" ? (
          <>
            <div style={{ padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
              <input
                type="text"
                placeholder="Search recordings..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  backgroundColor: "var(--bg-deep)",
                  color: "var(--text)",
                  fontSize: "12px",
                  outline: "none"
                }}
              />
            </div>
            {(stageCounts.complete > 0 || stageCounts.stage_a > 0) && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
                <button
                  className="chip"
                  style={{ color: stageFilter === "all" ? "var(--text)" : "var(--text-faint)", background: stageFilter === "all" ? "var(--surface-2)" : "transparent" }}
                  onClick={() => setStageFilter("all")}
                >
                  All ({doneRows.length})
                </button>
                {stageCounts.complete > 0 && (
                  <button
                    className="chip"
                    style={{ color: stageFilter === "complete" ? STAGE_COLOR.complete : "var(--text-faint)", background: stageFilter === "complete" ? "var(--surface-2)" : "transparent" }}
                    onClick={() => setStageFilter("complete")}
                  >
                    Complete ({stageCounts.complete})
                  </button>
                )}
                {stageCounts.stage_a > 0 && (
                  <button
                    className="chip"
                    style={{ color: stageFilter === "stage_a" ? STAGE_COLOR.stage_a : "var(--text-faint)", background: stageFilter === "stage_a" ? "var(--surface-2)" : "transparent" }}
                    onClick={() => setStageFilter("stage_a")}
                  >
                    Stage A only ({stageCounts.stage_a})
                  </button>
                )}
              </div>
            )}
            {prepareError && (
              <div style={{ margin: "8px 10px 0", fontSize: 11, color: "var(--coral)" }}>{prepareError}</div>
            )}
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
              <FolderTree
                root={browseTree}
                leafKey={(row) => row.path}
                renderFolderMeta={(node) => (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--text-faint)", flex: "none" }}>{countFiles(node)}</span>
                )}
                renderLeaf={(row) => {
                  const isDone = row.status === "done";
                  const isSelected = selectedPath === row.path;
                  const basename = row.path.split("/").pop() || row.path;
                  const dev = findDeviceId(row.path);
                  return (
                    <button disabled={!isDone} onClick={() => isDone && selectFile(row.path)} title={row.path}
                      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 12px",
                        background: isSelected ? "var(--surface-2)" : "transparent", border: "none",
                        borderLeft: isSelected ? "3px solid var(--amber)" : "3px solid transparent",
                        cursor: isDone ? "pointer" : "default", opacity: isDone ? 1 : 0.4, textAlign: "left", minWidth: 0 }}>
                      <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5, color: isSelected ? "var(--text)" : "var(--text-dim)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename}</span>
                      {dev && (
                        <span title={`AudioMoth ${dev}`} style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--violet)",
                          border: "1px solid var(--line)", borderRadius: 999, padding: "1px 5px", flex: "none" }}>{dev}</span>
                      )}
                      {stageByPath[row.path] && (
                        <span
                          title={STAGE_LABEL[stageByPath[row.path].stage]}
                          style={{ width: 6, height: 6, borderRadius: 99, flex: "none", background: STAGE_COLOR[stageByPath[row.path].stage] }}
                        />
                      )}
                      {isDone && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-faint)", border: "1px solid var(--line)", borderRadius: 999, padding: "1px 7px", fontVariantNumeric: "tabular-nums", flex: "none" }}>{row.n_events}</span>}
                    </button>
                  );
                }}
              />
            </div>
            {isTruncated && (
              <div style={{ padding: "8px 12px", fontSize: 10.5, color: "var(--text-faint)", textAlign: "center", borderTop: "1px solid var(--line)", fontStyle: "italic", background: "var(--bg-deep)" }}>
                Showing first {MAX_VISIBLE} files.<br />Use search to filter.
              </div>
            )}
          </>
        ) : (
          <>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", padding: "8px 10px", borderBottom: "1px solid var(--line)" }}>
              <button className="chip" onClick={selectAllFiles}>Use all</button>
              <button className="chip" onClick={selectNoFiles}>Use none</button>
              {brokenCount > 0 && (
                <button className="chip" style={{ color: "var(--coral)" }} onClick={excludeBroken}>Exclude broken ({brokenCount})</button>
              )}
              {stageACount > 0 && (
                <button className="chip" style={{ color: "var(--amber)" }} onClick={excludeStageAOnly}>Exclude Stage A only ({stageACount})</button>
              )}
            </div>
            {brokenCount > 0 && (
              <div style={{ margin: "8px 10px 0", fontSize: 11, color: "var(--coral)" }}>
                ⚠ {brokenCount} cached {brokenCount === 1 ? "file looks" : "files look"} broken — uncheck to re-analyze.
              </div>
            )}
            <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
              <FolderTree
                root={selectTree}
                leafKey={(f) => f.path}
                renderFolderMeta={(node) => (
                  <span style={{ fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--text-faint)", flex: "none" }}>{countFiles(node)}</span>
                )}
                renderLeaf={(f) => {
                  const basename = f.path.split("/").pop() || f.path;
                  const dev = findDeviceId(f.path);
                  return (
                    <label title={f.error ? `Error: ${f.error}` : f.path}
                      style={{ display: "flex", alignItems: "center", gap: 6, width: "100%", padding: "6px 12px", cursor: "pointer", minWidth: 0 }}>
                      <input type="checkbox" checked={selectedFiles.has(f.path)} onChange={() => toggleFileSelected(f.path)} />
                      <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text-dim)",
                        overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {f.broken && <span style={{ color: "var(--coral)", marginRight: 5 }}>⚠</span>}
                        {basename}
                      </span>
                      {dev && (
                        <span title={`AudioMoth ${dev}`} style={{ fontFamily: "var(--mono)", fontSize: 9, color: "var(--violet)",
                          border: "1px solid var(--line)", borderRadius: 999, padding: "1px 5px", flex: "none" }}>{dev}</span>
                      )}
                      <span className="status-pill" style={{ color: STAGE_COLOR[f.stage], flex: "none" }}>{STAGE_LABEL[f.stage]}</span>
                    </label>
                  );
                }}
              />
            </div>
          </>
        )}
      </aside>
      <section style={{ display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg-deep)", padding: 12, gap: 12 }}>
        {notice && (
          <div className="notice reveal" style={{ fontSize: 12 }}>
            {notice}
            <button onClick={() => setNotice(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>✕</button>
          </div>
        )}
        {mode === "select" ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 14, textAlign: "center", padding: "0 40px" }}>
            <h3 style={{ margin: 0 }}>Choose which cached recordings to reuse</h3>
            <p className="sub" style={{ margin: 0, maxWidth: 440 }}>
              Uncheck any recordings you want re-analyzed instead of reused — including ones flagged <b>broken</b>.
              Everything left checked is skipped on the next run.
            </p>
            <div className="mono" style={{ fontSize: 12.5, color: "var(--text-dim)" }}>
              {excludedCount > 0
                ? `${excludedCount} unchecked recording${excludedCount === 1 ? "" : "s"} will be re-analyzed.`
                : "Everything checked — nothing will be re-analyzed."}
            </div>
            {onProceedToAnalyze && (
              <button className="primary" style={{ height: 46, padding: "0 26px", fontSize: 14 }} onClick={handleNext} disabled={applying}>
                {applying ? "Applying…" : "Next: back to Analyze →"}
              </button>
            )}
          </div>
        ) : !selectedPath ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", fontFamily: "var(--serif)", fontStyle: "italic", fontSize: "1.05rem" }}>
            Select a completed recording to review its events.
          </div>
        ) : loadingEvents ? (
          <div style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, minHeight: 320, background: "var(--surface)", borderRadius: "var(--radius)", border: "1px solid var(--line)", boxShadow: "var(--shadow)" }}>
            <div className="loading-spinner" />
            <div style={{ color: "var(--text-dim)", fontSize: "11px", fontFamily: "var(--mono)", letterSpacing: "0.06em" }}>LOADING EVENTS…</div>
          </div>
        ) : (
          <>
            <div className="reveal" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
              <span
                title={selectedPath}
                style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {relativePath(selectedPath, opts.input) || selectedPath}
              </span>
              {selectedDevice && (
                <span className="status-pill" style={{ color: "var(--violet)", flex: "none" }}>
                  AudioMoth {selectedDevice}
                </span>
              )}
            </div>
            <div className="reveal" style={{ animationDelay: "40ms" }}>
              <AudioVisualizer src={src} events={events} selectedId={selectedId}
                onSelectEvent={handleSelectEvent} onUpdateBounds={handleUpdateBounds} onAddEvent={handleAddEvent} />
            </div>
            <div className="reveal" style={{ animationDelay: "130ms" }}>
              <EventTable events={events} selectedId={selectedId} onSelect={handleSelectEvent}
                onSetReview={handleSetReview} onDelete={handleDelete} onEditLabelNote={handleEditLabelNote} />
            </div>
          </>
        )}
      </section>
    </div>
  );
}
