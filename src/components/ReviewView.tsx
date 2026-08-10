import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { EventRow, FileRow, StartOpts, StartResult } from "../types";
import {
  addManualEvent, audioSrc, deleteEvent, listEvents, logReviewAction, prepareReview, restoreEvent,
  setEventReview, updateEventBounds,
} from "../api";
import { AudioVisualizer } from "./AudioVisualizer";
import { EventTable } from "./EventTable";
import VerificationPanel from "./VerificationPanel";
import { REVIEW_SHORTCUTS, useReviewShortcuts } from "../reviewShortcuts";

export interface ReviewViewProps {
  start: StartResult;
  opts: StartOpts;
  rows: FileRow[];
}

type BoxBounds = { tStart: number; tEnd: number; fLow: number; fHigh: number };
type BoxAction =
  | { type: "ADD"; eventId: number; path: string; bounds: BoxBounds }
  | { type: "DELETE"; eventId: number; path: string; eventRow: EventRow };

function remapActionId(action: BoxAction, path: string, oldId: number, newId: number): BoxAction {
  if (action.path !== path || action.eventId !== oldId) return action;
  if (action.type === "DELETE") {
    return { ...action, eventId: newId, eventRow: { ...action.eventRow, id: newId } };
  }
  return { ...action, eventId: newId };
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
  const [showShortcuts, setShowShortcuts] = useState(false);
  const currentPathRef = useRef<string | null>(null);
  const eventRequestId = useRef(0);
  const [history, setHistory] = useState<BoxAction[]>([]);
  const [redoStack, setRedoStack] = useState<BoxAction[]>([]);
  const mutationBusyRef = useRef(false);
  const [mutationBusy, setMutationBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    prepareReview(dir, sid).catch((e) => { if (!cancelled) setPrepareError(String(e)); });
    return () => { cancelled = true; };
  }, [dir, sid]);

  const fetchEvents = useCallback(async (path: string, showLoading = false) => {
    if (currentPathRef.current !== path) return null;
    const requestId = ++eventRequestId.current;
    if (showLoading) {
      setLoadingEvents(true);
    }
    try {
      const result = await listEvents(dir, sid, path);
      if (currentPathRef.current === path && eventRequestId.current === requestId) {
        setEvents(result);
        return result;
      }
    } catch (e) {
      if (currentPathRef.current === path && eventRequestId.current === requestId) {
        setNotice(`Failed to load events: ${String(e)}`);
      }
    } finally {
      if (currentPathRef.current === path && eventRequestId.current === requestId && showLoading) {
        setLoadingEvents(false);
      }
    }
    return null;
  }, [dir, sid]);

  const refreshEvents = useCallback(async () => {
    if (selectedPath) await fetchEvents(selectedPath, false);
  }, [selectedPath, fetchEvents]);

  const selectFile = useCallback((path: string, targetEventId?: number) => {
    if (mutationBusyRef.current) {
      setNotice("Wait for the current bounding-box edit to finish before switching recordings.");
      return;
    }
    if (path === selectedPath) {
      if (targetEventId !== undefined) setSelectedId(targetEventId);
      return;
    }
    currentPathRef.current = path;
    eventRequestId.current += 1;
    setSelectedPath(path); setSelectedId(null); setEvents([]); setNotice(null);
    setHistory([]); setRedoStack([]);
    void logReviewAction(dir, sid, "open_file", null, { path });
    void fetchEvents(path, true).then((loaded) => {
      if (targetEventId === undefined) return;
      if (loaded?.some((event) => event.id === targetEventId)) {
        setSelectedId(targetEventId);
      } else {
        setNotice(`Verification event #${targetEventId} was not found in ${path}.`);
      }
    });
  }, [selectedPath, fetchEvents, dir, sid]);

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
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      const bounds = { tStart: e.t_start, tEnd: e.t_end, fLow: e.f_low, fHigh: e.f_high };
      const newId = await addManualEvent(dir, sid, selectedPath, bounds);
      await refreshEvents(); setSelectedId(newId);
      setHistory((h) => [...h, { type: 'ADD', eventId: newId, path: selectedPath, bounds }]);
      setRedoStack([]);
      setNotice("Added new event bounding box.");
    } catch (err) {
      setNotice(`Add event failed: ${String(err)}`);
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [dir, sid, selectedPath, refreshEvents]);
  const handleDelete = useCallback(async (id: number) => {
    if (mutationBusyRef.current) return;
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      const ev = events.find((item) => item.id === id);
      if (!ev || !selectedPath) throw new Error(`Event #${id} is not loaded in the current recording.`);
      await deleteEvent(dir, id);
      if (selectedId === id) setSelectedId(null);
      await refreshEvents();
      setHistory((h) => [...h, { type: 'DELETE', eventId: id, path: selectedPath, eventRow: ev }]);
      setRedoStack([]);
      setNotice(`Deleted bounding box #${id}.`);
    } catch (e) {
      setNotice(`Delete failed: ${String(e)}`);
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [dir, selectedId, events, selectedPath, refreshEvents]);
  const handleEditLabelNote = useCallback(async (id: number, label: string, note: string) => {
    try { await setEventReview(dir, id, currentStatus(id), label, note); await refreshEvents(); }
    catch (e) { setNotice(`Label/note update failed: ${String(e)}`); }
  }, [dir, currentStatus, refreshEvents]);

  const handleUndo = useCallback(async () => {
    if (history.length === 0 || mutationBusyRef.current) return;
    const lastAction = history[history.length - 1];
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      let redoAction = lastAction;
      if (lastAction.type === 'ADD') {
        await deleteEvent(dir, lastAction.eventId);
        if (selectedId === lastAction.eventId) setSelectedId(null);
        setNotice("Undo: Removed added bounding box.");
      } else {
        const restoredId = await restoreEvent(dir, sid, lastAction.path, lastAction.eventRow);
        const restoredRow = { ...lastAction.eventRow, id: restoredId };
        redoAction = { ...lastAction, eventId: restoredId, eventRow: restoredRow };
        setSelectedId(restoredId);
        setNotice("Undo: Restored deleted bounding box.");
        setHistory((h) => h.slice(0, -1).map((action) =>
          remapActionId(action, lastAction.path, lastAction.eventId, restoredId)));
        setRedoStack((r) => [
          ...r.map((action) => remapActionId(action, lastAction.path, lastAction.eventId, restoredId)),
          redoAction,
        ]);
      }
      await refreshEvents();
      if (lastAction.type === 'ADD') {
        setHistory((h) => h.slice(0, -1));
        setRedoStack((r) => [...r, redoAction]);
      }
    } catch (error) {
      setNotice(`Undo failed: ${String(error)}`);
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [history, dir, sid, selectedId, refreshEvents]);

  const handleRedo = useCallback(async () => {
    if (redoStack.length === 0 || mutationBusyRef.current) return;
    const lastRedo = redoStack[redoStack.length - 1];
    mutationBusyRef.current = true;
    setMutationBusy(true);
    try {
      let historyAction = lastRedo;
      if (lastRedo.type === 'ADD') {
        const restoredId = await addManualEvent(dir, sid, lastRedo.path, lastRedo.bounds);
        historyAction = { ...lastRedo, eventId: restoredId };
        setSelectedId(restoredId);
        setNotice("Redo: Re-created bounding box.");
        setRedoStack((r) => r.slice(0, -1).map((action) =>
          remapActionId(action, lastRedo.path, lastRedo.eventId, restoredId)));
        setHistory((h) => [
          ...h.map((action) => remapActionId(action, lastRedo.path, lastRedo.eventId, restoredId)),
          historyAction,
        ]);
      } else {
        await deleteEvent(dir, lastRedo.eventId);
        if (selectedId === lastRedo.eventId) setSelectedId(null);
        setNotice("Redo: Deleted bounding box.");
      }
      await refreshEvents();
      if (lastRedo.type === 'DELETE') {
        setRedoStack((r) => r.slice(0, -1));
        setHistory((h) => [...h, historyAction]);
      }
    } catch (error) {
      setNotice(`Redo failed: ${String(error)}`);
    } finally {
      mutationBusyRef.current = false;
      setMutationBusy(false);
    }
  }, [redoStack, dir, sid, selectedId, refreshEvents]);

  const handleVerificationSelect = useCallback((id: number, path: string) => {
    selectFile(path, id);
  }, [selectFile]);

  useEffect(() => {
    const handleKeyDown = (ev: KeyboardEvent) => {
      const isText = ev.target instanceof HTMLElement &&
        (ev.target.tagName === "INPUT" || ev.target.tagName === "TEXTAREA" ||
          ev.target.tagName === "SELECT" || ev.target.isContentEditable);
      if (isText) return;

      const isCmdOrCtrl = ev.metaKey || ev.ctrlKey;
      if (isCmdOrCtrl && ev.key.toLowerCase() === 'z') {
        ev.preventDefault();
        if (ev.shiftKey) {
          void handleRedo();
        } else {
          void handleUndo();
        }
      } else if (isCmdOrCtrl && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        void handleRedo();
      } else if (ev.key === 'Delete' || ev.key === 'Backspace' || ev.key === 'd' || ev.key === 'D' || ev.code === 'Delete' || ev.code === 'Backspace') {
        if (selectedId !== null) {
          ev.preventDefault();
          void handleDelete(selectedId);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleUndo, handleRedo, handleDelete, selectedId]);

  const logAction = useCallback((action: string, meta?: Record<string, unknown>) => {
    const eventId = typeof meta?.eventId === "number" ? meta.eventId : null;
    void logReviewAction(dir, sid, action, eventId, meta);
  }, [dir, sid]);

  useReviewShortcuts({
    events,
    selectedId,
    enabled: !!selectedPath && !loadingEvents,
    onSelect: handleSelectEvent,
    onDecide: handleSetReview,
    onToggleHelp: () => setShowShortcuts((v) => !v),
    onAction: logAction,
  });

  const reviewProgress = useMemo(() => {
    const decided = events.filter((e) => e.review_status !== "unreviewed").length;
    return { decided, total: events.length };
  }, [events]);

  const src = selectedPath ? audioSrc(selectedPath) : null;
  const dbPath = `${dir.replace(/[/\\]+$/, "")}/batch.db`;

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
              <button key={row.path} className="ba-file" disabled={!isDone || mutationBusy} onClick={() => isDone && selectFile(row.path)} title={row.path}
                style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "6px 12px",
                  background: isSelected ? "var(--surface-2)" : "transparent", border: "none",
                  borderLeft: isSelected ? "3px solid var(--amber)" : "3px solid transparent",
                  cursor: isDone && !mutationBusy ? "pointer" : "default", opacity: isDone ? 1 : 0.4, textAlign: "left", minWidth: 0 }}>
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
        {selectedPath && (
          <div style={{ display: "flex", alignItems: "center", gap: 12, fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--text-faint)" }}>
            <span style={{ fontVariantNumeric: "tabular-nums" }}>
              REVIEWED {reviewProgress.decided}/{reviewProgress.total}
            </span>
            <button
              onClick={handleUndo}
              disabled={history.length === 0 || mutationBusy}
              style={{
                background: 'none', border: '1px solid var(--line)', borderRadius: 6,
                padding: '2px 8px', color: history.length > 0 ? 'var(--amber)' : 'var(--text-faint)',
                cursor: history.length > 0 && !mutationBusy ? 'pointer' : 'default', fontFamily: 'var(--mono)', fontSize: 10.5,
                opacity: history.length > 0 && !mutationBusy ? 1 : 0.4
              }}
              title="Undo last bounding box action (Cmd+Z)"
            >
              ↩ Undo ({history.length})
            </button>
            <button
              onClick={handleRedo}
              disabled={redoStack.length === 0 || mutationBusy}
              style={{
                background: 'none', border: '1px solid var(--line)', borderRadius: 6,
                padding: '2px 8px', color: redoStack.length > 0 ? 'var(--amber)' : 'var(--text-faint)',
                cursor: redoStack.length > 0 && !mutationBusy ? 'pointer' : 'default', fontFamily: 'var(--mono)', fontSize: 10.5,
                opacity: redoStack.length > 0 && !mutationBusy ? 1 : 0.4
              }}
              title="Redo bounding box action (Cmd+Shift+Z / Cmd+Y)"
            >
              ↪ Redo ({redoStack.length})
            </button>
            <button onClick={() => setShowShortcuts((v) => !v)}
              style={{ marginLeft: "auto", background: "none", border: "1px solid var(--line)", borderRadius: 6,
                padding: "2px 8px", color: "var(--text-dim)", cursor: "pointer", fontFamily: "var(--mono)", fontSize: 10.5 }}>
              {showShortcuts ? "hide keys" : "? keys"}
            </button>
          </div>
        )}
        {showShortcuts && (
          <div className="reveal" style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)", padding: "10px 13px" }}>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: "4px 18px" }}>
              {REVIEW_SHORTCUTS.map((s) => (
                <div key={s.keys} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5 }}>
                  <kbd style={{ fontFamily: "var(--mono)", fontSize: 10.5, border: "1px solid var(--line)", borderRadius: 4,
                    padding: "1px 6px", color: "var(--text)", background: "var(--bg-deep)", whiteSpace: "nowrap" }}>{s.keys}</kbd>
                  <span style={{ color: "var(--text-dim)" }}>{s.description}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        <VerificationPanel dbPath={dbPath} sessionId={sid} thetaA={opts.thetaA} thetaB={opts.thetaB}
          onSelectEvent={handleVerificationSelect} onLogAction={logAction} />
        {!selectedPath ? (
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
            <div className="reveal" style={{ animationDelay: "40ms" }}>
              <AudioVisualizer src={src} events={events} selectedId={selectedId}
                onSelectEvent={handleSelectEvent} onUpdateBounds={handleUpdateBounds} onAddEvent={handleAddEvent}
                onDeleteEvent={handleDelete} frequencyMax={opts.fMaxHz} />
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
