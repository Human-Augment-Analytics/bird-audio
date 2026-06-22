import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventRow, FileRow, StartOpts, StartResult } from "../types";
import {
  addManualEvent, audioSrc, deleteEvent, listEvents, prepareReview, setEventReview, updateEventBounds,
} from "../api";
import { AudioVisualizer } from "./AudioVisualizer";
import { EventTable } from "./EventTable";

export interface ReviewViewProps {
  start: StartResult;
  opts: StartOpts;
  rows: FileRow[];
}

export default function ReviewView({ start, opts, rows }: ReviewViewProps) {
  const sid = start.session_id;
  const dir = opts.outputDir;

  const [prepareError, setPrepareError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loadingEvents, setLoadingEvents] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const currentPathRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    prepareReview(dir, sid).catch((e) => { if (!cancelled) setPrepareError(String(e)); });
    return () => { cancelled = true; };
  }, [dir, sid]);

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

  const MAX_VISIBLE = 150;

  const { doneRows, visibleRows, isTruncated } = useMemo(() => {
    const done = rows.filter((r) => r.status === "done");
    const filtered = done.filter((r) => {
      const basename = r.path.split("/").pop() || r.path;
      return basename.toLowerCase().includes(searchQuery.toLowerCase());
    });
    return {
      doneRows: done,
      visibleRows: filtered.slice(0, MAX_VISIBLE),
      isTruncated: filtered.length > MAX_VISIBLE,
    };
  }, [rows, searchQuery]);

  return (
    <div className="reveal" style={{ display: "grid", gridTemplateColumns: "264px 1fr", gap: 0,
      minHeight: 520, border: "1px solid var(--line)", borderRadius: "var(--radius)", overflow: "hidden", background: "var(--surface)", boxShadow: "var(--shadow)" }}>
      <aside style={{ borderRight: "1px solid var(--line)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
        <div style={{ padding: "11px 13px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700, letterSpacing: "0.12em", color: "var(--text-faint)" }}>RECORDINGS</span>
          <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>{doneRows.length}/{rows.length}</span>
        </div>
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
        {prepareError && (
          <div style={{ margin: "8px 10px 0", fontSize: 11, color: "var(--coral)" }}>{prepareError}</div>
        )}
        <div style={{ flex: 1, overflowY: "auto", padding: "6px 0" }}>
          {visibleRows.map((row) => {
            const isDone = row.status === "done";
            const isSelected = selectedPath === row.path;
            const basename = row.path.split("/").pop() || row.path;
            return (
              <button key={row.path} className="ba-file" disabled={!isDone} onClick={() => isDone && selectFile(row.path)} title={row.path}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 12px",
                  background: isSelected ? "var(--surface-2)" : "transparent", border: "none",
                  borderLeft: isSelected ? "3px solid var(--amber)" : "3px solid transparent",
                  cursor: isDone ? "pointer" : "default", opacity: isDone ? 1 : 0.4, textAlign: "left", minWidth: 0 }}>
                <span style={{ flex: 1, fontFamily: "var(--mono)", fontSize: 11.5, color: isSelected ? "var(--text)" : "var(--text-dim)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{basename}</span>
                {isDone && <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--text-faint)", border: "1px solid var(--line)", borderRadius: 999, padding: "1px 7px", fontVariantNumeric: "tabular-nums" }}>{row.n_events}</span>}
              </button>
            );
          })}
        </div>
        {isTruncated && (
          <div style={{ padding: "8px 12px", fontSize: 10.5, color: "var(--text-faint)", textAlign: "center", borderTop: "1px solid var(--line)", fontStyle: "italic", background: "var(--bg-deep)" }}>
            Showing first {MAX_VISIBLE} files.<br />Use search to filter.
          </div>
        )}
      </aside>
      <section style={{ display: "flex", flexDirection: "column", overflow: "auto", background: "var(--bg-deep)", padding: 12, gap: 12 }}>
        {notice && (
          <div className="notice reveal" style={{ fontSize: 12 }}>
            {notice}
            <button onClick={() => setNotice(null)} style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-dim)", cursor: "pointer" }}>✕</button>
          </div>
        )}
        {!selectedPath ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-faint)", fontFamily: "var(--serif)", fontStyle: "italic", fontSize: "1.05rem" }}>
            Select a completed recording to review its events.
          </div>
        ) : loadingEvents ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)" }}>Loading events…</div>
        ) : (
          <>
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
