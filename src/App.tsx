import { useEffect, useRef, useState } from "react";
import SetupView from "./components/SetupView";
import RunView from "./components/RunView";
import ReviewView from "./components/ReviewView";
import { EcologyView } from "./components/EcologyView";
import appIcon from "./assets/app-icon.png";
import { cancelSession, exportSession, getSummary, listFiles, onBatchError, onDone, onProgress, pickSavePath } from "./api";
import type { FileRow, Progress, StartOpts, StartResult, Summary } from "./types";

export default function App() {
  const [view, setView] = useState<"setup" | "run">("setup");
  const [section, setSection] = useState<"batch" | "review" | "ecology">("batch");
  const [start, setStart] = useState<StartResult | null>(null);
  const [opts, setOpts] = useState<StartOpts | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [throughput, setThroughput] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const tRef = useRef<{ t: number; done: number } | null>(null);

  useEffect(() => {
    if (view !== "run" || !start || !opts) return;
    let active = true;
    let terminal = false;
    let terminalRowsLoaded = false;
    let refreshInFlight = false;
    let unP: (() => void) | undefined;
    let unD: (() => void) | undefined;
    let unE: (() => void) | undefined;
    const sessionId = start.session_id;
    const acceptSummary = (next: Summary) => {
      if (!active || next.session_id !== sessionId) return;
      if (["done", "cancelled", "failed"].includes(next.status)) {
        terminal = true;
        setSummary(next);
      }
    };
    const refresh = async () => {
      if (!active || refreshInFlight || (terminal && terminalRowsLoaded)) return;
      refreshInFlight = true;
      try {
        const [nextSummary, nextRows] = await Promise.all([
          getSummary(opts.outputDir, sessionId),
          listFiles(opts.outputDir, sessionId),
        ]);
        if (!active) return;
        setRows(nextRows);
        acceptSummary(nextSummary);
        if (["done", "cancelled", "failed"].includes(nextSummary.status)) {
          terminalRowsLoaded = true;
        }
        setNotice((current) => current?.startsWith("Session refresh failed:") || current?.startsWith("File refresh failed:") ? null : current);
      } catch (reason) {
        if (active) setNotice(`Session refresh failed: ${String(reason)}`);
      } finally {
        refreshInFlight = false;
      }
    };
    (async () => {
      const [progressUnlisten, doneUnlisten, errorUnlisten] = await Promise.all([
        onProgress((p) => {
        if (!active || p.session_id !== sessionId) return;
        setProgress(p);
        const now = Date.now();
        const prev = tRef.current;
        if (prev && now > prev.t) {
          const rate = ((p.done - prev.done) * 1000) / (now - prev.t);
          setThroughput((cur) => (cur === 0 ? Math.max(rate, 0) : cur * 0.7 + Math.max(rate, 0) * 0.3));
        }
        tRef.current = { t: now, done: p.done };
        }),
        onDone((s) => {
          if (!active || s.session_id !== sessionId) return;
          acceptSummary(s);
          terminalRowsLoaded = false;
          void refresh();
        }),
        onBatchError((message) => {
          if (!active) return;
          setNotice(`Session failed internally: ${message}`);
          void refresh();
        }),
      ]);
      unP = progressUnlisten;
      unD = doneUnlisten;
      unE = errorUnlisten;
      if (!active) {
        unP?.();
        unD?.();
        unE?.();
        return;
      }
      await refresh();
    })().catch((reason) => {
      if (active) setNotice(`Session listener failed: ${String(reason)}`);
    });
    const iv = setInterval(() => { void refresh(); }, 1000);
    return () => {
      active = false;
      unP?.();
      unD?.();
      unE?.();
      clearInterval(iv);
    };
  }, [view, start, opts]);

  const onStarted = (result: StartResult, o: StartOpts) => {
    setStart(result);
    setOpts(o);
    setProgress(null);
    setSummary(null);
    setRows([]);
    setThroughput(0);
    setNotice(null);
    setCancelled(false);
    tRef.current = null;
    setView("run");
  };

  const handleCancel = async () => {
    setCancelled(true);
    try {
      await cancelSession();
    } catch (reason) {
      setCancelled(false);
      setNotice(`Cancellation failed: ${String(reason)}`);
    }
  };

  const handleNewSession = () => {
    setView("setup");
    setSection("batch");
    setStart(null);
    setOpts(null);
    setProgress(null);
    setSummary(null);
    setRows([]);
    setThroughput(0);
    setNotice(null);
    setCancelled(false);
    tRef.current = null;
  };

  const doExport = async (fmt: string, completeOnly: boolean, confirmedOnly: boolean, metadataPath: string | null) => {
    if (!start || !opts) return;
    const ext = fmt === "json" ? "json" : fmt === "raven" ? "txt" : "csv";
    const path = await pickSavePath(`events.${ext}`);
    if (!path) return;
    try {
      const n = await exportSession(opts.outputDir, start.session_id, path, fmt, completeOnly, confirmedOnly, metadataPath);
      let msg = `Exported ${n} rows to ${path}`;
      if (metadataPath) {
        msg += ` (and summary to ${path.replace(/\.[^/.]+$/, "")}_summary.csv)`;
      }
      setNotice(msg);
    } catch (e) {
      setNotice(`Export failed: ${String(e)}`);
    }
  };

  const noticeIsError = notice !== null && /failed|error/i.test(notice);
  const analyticsAvailable = summary !== null && ["done", "failed", "cancelled"].includes(summary.status);

  return (
    <main style={{ padding: "44px 24px 64px", maxWidth: 1040, margin: "0 auto" }}>
      <header className="masthead reveal">
        <img className="masthead-icon" src={appIcon} alt="Bird Audio Analyzer Icon" aria-hidden="true" />
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Bioacoustic Analysis Pipeline</div>
          <h1>Bird Audio Analyzer</h1>
          <div className="sub">
            Detecting <b>buzzes</b> in bird field recordings
          </div>
        </div>
      </header>

      <nav className="reveal" style={{ display: "flex", gap: 8, margin: "0 0 16px" }}>
        <button className={section === "batch" ? "primary" : "backlink"} onClick={() => setSection("batch")}>Batch</button>
        <button className={section === "review" ? "primary" : "backlink"} onClick={() => setSection("review")} disabled={!start || !opts}>
          Review
        </button>
        <button
          className={section === "ecology" ? "primary" : "backlink"}
          onClick={() => setSection("ecology")}
          disabled={!analyticsAvailable}
          title={analyticsAvailable ? "Open session analytics" : "Available after the batch session reaches a terminal state"}
        >
          Analytics
        </button>
      </nav>

      {section === "batch" && view === "setup" && <SetupView onStarted={onStarted} />}
      {section === "batch" && view === "run" && start && (
        <>
          <button className="backlink reveal" style={{ marginBottom: 14 }} disabled={summary === null} onClick={handleNewSession}>
            ← Start a new session
          </button>
          {notice && (
            <div className="notice reveal">
              <span className={`dot ${noticeIsError ? "dot--bad" : "dot--ok"}`} /> {notice}
            </div>
          )}
          <RunView
            start={start}
            progress={progress}
            summary={summary}
            rows={rows}
            throughput={throughput}
            onExport={doExport}
            onCancel={handleCancel}
            cancelled={cancelled}
            outputDir={opts?.outputDir || ""}
          />
        </>
      )}
      {section === "review" && start && opts && (
        <ReviewView start={start} opts={opts} rows={rows} />
      )}
      {section === "ecology" && (
        <EcologyView
          sessionId={start ? start.session_id : null}
          dbPath={opts ? `${opts.outputDir}/batch.db` : null}
          sessionStatus={summary?.status ?? null}
        />
      )}
    </main>
  );
}
