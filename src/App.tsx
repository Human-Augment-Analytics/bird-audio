import { useEffect, useRef, useState } from "react";
import SetupView from "./components/SetupView";
import CardSetupView from "./components/CardSetupView";
import RunView from "./components/RunView";
import ReviewView from "./components/ReviewView";
import appIcon from "./assets/app-icon.png";
import { cancelSession, exportSession, getFeatureFlags, getSummary, listFiles, onDone, onProgress, pickSavePath } from "./api";
import type { FileRow, Progress, StartOpts, StartResult, Summary } from "./types";

export default function App() {
  const [view, setView] = useState<"setup" | "run">("setup");
  const [section, setSection] = useState<"batch" | "review">("batch");
  const [cardUi, setCardUi] = useState(false);

  useEffect(() => {
    getFeatureFlags().then((f) => setCardUi(f?.card_ui === true)).catch(() => setCardUi(false));
  }, []);
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
      if (!active) {
        unP?.();
        unD?.();
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

  const handleCancel = () => {
    setCancelled(true);
    cancelSession();
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
        <div>
          <div className="eyebrow" style={{ marginBottom: 8 }}>Bioacoustic Analysis Pipeline</div>
          <h1>Bird Audio Analyzer</h1>
          <div className="sub">
            Detecting <b>buzzes</b> in bird field recordings
          </div>
        </div>
      </header>

      <nav className="reveal" style={{ display: "flex", gap: 32, margin: "0 0 28px" }}>
        <button className={section === "batch" ? "primary" : "backlink"} onClick={() => setSection("batch")}>Analyze</button>
        <button className={section === "review" ? "primary" : "backlink"} onClick={() => setSection("review")} disabled={!start || !opts}>
          Review
        </button>
      </nav>

      {section === "batch" && view === "setup" && (
        cardUi ? <CardSetupView onStarted={onStarted} /> : <SetupView onStarted={onStarted} />
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
            throughput={throughput}
            onExport={doExport}
            onCancel={handleCancel}
            outputDir={opts?.outputDir || ""}
          />
        </>
      )}
      {section === "review" && start && opts && (
        <ReviewView start={start} opts={opts} rows={rows} />
      )}
    </main>
  );
}
