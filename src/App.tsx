import { useEffect, useRef, useState } from "react";
import SetupView from "./components/SetupView";
import CardSetupView, { type CardSetupViewHandle } from "./components/CardSetupView";
import RunView from "./components/RunView";
import ReviewView from "./components/ReviewView";
import appIcon from "./assets/app-icon.png";
import { cancelSession, exportSession, getFeatureFlags, getReviewSession, getSummary, listFiles, onDone, onFileDone, onProgress, pickSavePath, retryFailed, startSession } from "./api";
import type { FileDone, FileRow, Progress, StartOpts, StartResult, Summary } from "./types";

const LAST_RUN_KEY = "birdaudio.lastRun";

const UI_MODE_KEY = "birdaudio.uiMode";

export default function App() {
  const [view, setView] = useState<"setup" | "run">("setup");
  const [section, setSection] = useState<"batch" | "review">("batch");

  // Layout preference: card-based guided flow vs. the classic full-page form.
  // Defaults to the `card_ui` feature flag, but once the researcher flips the
  // toggle themselves we remember that choice in this browser from then on.
  const savedUiMode = localStorage.getItem(UI_MODE_KEY);
  const [uiMode, setUiModeState] = useState<"card" | "full">(
    savedUiMode === "card" || savedUiMode === "full" ? savedUiMode : "card"
  );
  const [uiModeIsUserSet, setUiModeIsUserSet] = useState(savedUiMode === "card" || savedUiMode === "full");

  const setUiMode = (m: "card" | "full") => {
    setUiModeState(m);
    setUiModeIsUserSet(true);
    localStorage.setItem(UI_MODE_KEY, m);
  };

  useEffect(() => {
    getFeatureFlags().then((f) => {
      if (!uiModeIsUserSet) setUiModeState(f?.card_ui === true ? "card" : "full");
    }).catch(() => {});
    // Only meant to seed the default once, before the user has an opinion.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [start, setStart] = useState<StartResult | null>(null);
  const [opts, setOpts] = useState<StartOpts | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [rows, setRows] = useState<FileRow[]>([]);
  const [throughput, setThroughput] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [activity, setActivity] = useState<FileDone[]>([]);
  const [resume, setResume] = useState<{ opts: StartOpts; unfinished: number } | null>(null);
  const tRef = useRef<{ t: number; done: number } | null>(null);
  const cardSetupRef = useRef<CardSetupViewHandle>(null);

  // On launch, if the last run left files unfinished (interruption/crash), offer
  // to continue it straight from the saved settings — no folder picker needed.
  useEffect(() => {
    const raw = localStorage.getItem(LAST_RUN_KEY);
    if (!raw) return;
    let saved: StartOpts;
    try { saved = JSON.parse(raw) as StartOpts; } catch { return; }
    let active = true;
    (async () => {
      try {
        const session = await getReviewSession(saved.outputDir);
        if (!session || !active) return;
        const s = await getSummary(saved.outputDir, session.session_id);
        // Resume (start_session) reprocesses pending + orphaned in_progress files;
        // terminally-failed files are left to the explicit Retry button instead.
        const unfinished = s.pending + s.in_progress;
        if (active && unfinished > 0) setResume({ opts: saved, unfinished });
      } catch { /* no resumable run — ignore */ }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    if (view === "run" && start && opts && !summary) {
      // Check if we missed the 'done' event due to a race
      getSummary(opts.outputDir, start.session_id).then((s) => {
        if (active && s.pending === 0 && s.in_progress === 0) {
          setSummary(s);
          listFiles(opts.outputDir, start.session_id).then((r) => {
            if (active) setRows(r);
          }).catch(() => {});
        }
      });
    }
    return () => { active = false; };
  }, [view, start, opts, summary]);

  useEffect(() => {
    if (view !== "run" || !start || !opts) return;
    let active = true;
    let unP: (() => void) | undefined;
    let unD: (() => void) | undefined;
    let unF: (() => void) | undefined;
    (async () => {
      unP = await onProgress((p) => {
        setProgress(p);
        const now = Date.now();
        const prev = tRef.current;
        if (prev && now > prev.t) {
          const rate = ((p.done - prev.done) * 1000) / (now - prev.t);
          setThroughput((cur) => (cur === 0 ? Math.max(rate, 0) : cur * 0.7 + Math.max(rate, 0) * 0.3));
        }
        tRef.current = { t: now, done: p.done };
      });
      unD = await onDone((s) => {
        setSummary(s);
        listFiles(opts.outputDir, start.session_id).then(setRows).catch(() => {});
      });
      unF = await onFileDone((f) => {
        // Keep a bounded, newest-first activity log of stored/failed files.
        setActivity((prev) => [f, ...prev].slice(0, 50));
      });
      if (!active) {
        unP?.();
        unD?.();
        unF?.();
      }
    })();
    // Only poll listFiles if the run is active and not complete/cancelled
    let iv: any;
    if (!summary && !cancelled) {
      iv = setInterval(() => {
        listFiles(opts.outputDir, start.session_id).then(setRows).catch(() => {});
      }, 2000);
    }
    return () => {
      active = false;
      unP?.();
      unD?.();
      unF?.();
      if (iv) clearInterval(iv);
    };
  }, [view, start, opts, summary, cancelled]);

  // Remember how long each recording takes so the setup flow can estimate the
  // next run's duration before it starts.
  useEffect(() => {
    if (summary && summary.done > 0 && progress?.elapsed_ms_total) {
      localStorage.setItem("birdaudio.secPerFile", String(progress.elapsed_ms_total / 1000 / summary.done));
    }
  }, [summary, progress]);

  const onViewCachedResults = (result: StartResult, o: StartOpts, r: FileRow[]) => {
    setStart(result);
    setOpts(o);
    setRows(r);
    setSection("review");
  };

  const onStarted = (result: StartResult, o: StartOpts) => {
    setStart(result);
    setOpts(o);
    setProgress(null);
    setSummary(null);
    setRows([]);
    setThroughput(0);
    setNotice(null);
    setCancelled(false);
    setActivity([]);
    setResume(null);
    tRef.current = null;
    // Remember this run so an interruption can be resumed without re-picking.
    try { localStorage.setItem(LAST_RUN_KEY, JSON.stringify(o)); } catch { /* ignore quota */ }
    setView("run");
  };

  const handleCancel = () => {
    setCancelled(true);
    cancelSession();
  };

  // Re-run this session's failed files without leaving the run view.
  const handleRetryFailed = async () => {
    if (!start || !opts) return;
    setSummary(null);
    setCancelled(false);
    setActivity([]);
    setThroughput(0);
    tRef.current = null;
    try {
      const result = await retryFailed(opts, start.session_id);
      setStart(result);
    } catch (e) {
      setNotice(`Retry failed: ${String(e)}`);
    }
  };

  // Resume the last interrupted run straight from saved settings.
  const handleResume = async () => {
    if (!resume) return;
    try {
      const result = await startSession(resume.opts);
      onStarted(result, resume.opts);
    } catch (e) {
      setNotice(`Could not resume: ${String(e)}`);
    }
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

  return (
    <main style={{ padding: "44px 24px 64px", maxWidth: 1040, margin: "0 auto" }}>
      <header className="masthead reveal">
        <img className="masthead-icon" src={appIcon} alt="Bird Audio Analyzer Icon" aria-hidden="true" />
        <div style={{ flex: 1 }}>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Bioacoustic Analysis Pipeline</div>
          <h1>Bird Audio Analyzer</h1>
          <div className="sub">
            Detecting <b>buzzes</b> in bird field recordings
          </div>
        </div>
        {section === "batch" && view === "setup" && (
          <div className="ui-mode-toggle" role="group" aria-label="Setup layout">
            <button
              className={uiMode === "card" ? "active" : ""}
              aria-pressed={uiMode === "card"}
              onClick={() => setUiMode("card")}
            >
              Guided cards
            </button>
            <button
              className={uiMode === "full" ? "active" : ""}
              aria-pressed={uiMode === "full"}
              onClick={() => setUiMode("full")}
            >
              Full page
            </button>
          </div>
        )}
      </header>

      <nav className="reveal" style={{ display: "flex", gap: 32, margin: "0 0 28px" }}>
        <button className={section === "batch" ? "primary" : "backlink"} onClick={() => setSection("batch")}>Analyze</button>
        <button className={section === "review" ? "primary" : "backlink"} onClick={() => setSection("review")} disabled={!start || !opts}>
          Review
        </button>
      </nav>

      {/* Kept mounted (just hidden) while section flips to "review" and back,
          so the setup card's own step/folder state isn't lost. */}
      {view === "setup" && section === "batch" && resume && (
        <div className="notice reveal" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap", marginBottom: 18 }}>
          <span>
            <span className="dot dot--ok" /> A previous run in{" "}
            <b>{resume.opts.input.split("/").pop() || resume.opts.input}</b> was interrupted —{" "}
            {resume.unfinished} recording{resume.unfinished === 1 ? "" : "s"} left to analyze.
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <button className="primary" onClick={handleResume}>▸ Resume run</button>
            <button className="backlink" onClick={() => setResume(null)}>Dismiss</button>
          </span>
        </div>
      )}
      {view === "setup" && (
        <div style={{ display: section === "batch" ? "contents" : "none" }}>
          {uiMode === "card" ? <CardSetupView ref={cardSetupRef} onStarted={onStarted} onViewResults={onViewCachedResults} /> : <SetupView onStarted={onStarted} />}
        </div>
      )}
      {section === "batch" && view === "run" && start && (
        <>
          <button className="backlink reveal" style={{ marginBottom: 14 }} disabled={summary === null && !cancelled} onClick={() => setView("setup")}>
            ← Start a new session
          </button>
          {notice && (
            <div className="notice reveal">
              <span className="dot dot--ok" /> {notice}
            </div>
          )}
          <RunView
            start={start}
            progress={progress}
            summary={summary}
            rows={rows}
            activity={activity}
            throughput={throughput}
            onExport={doExport}
            onCancel={handleCancel}
            onRetryFailed={handleRetryFailed}
            outputDir={opts?.outputDir || ""}
            inputDir={opts?.input || ""}
          />
        </>
      )}
      {section === "review" && start && opts && (
        <ReviewView
          start={start}
          opts={opts}
          rows={rows}
          onProceedToAnalyze={view === "setup" ? () => {
            cardSetupRef.current?.returnToAnalyze();
            setSection("batch");
          } : undefined}
        />
      )}
    </main>
  );
}
