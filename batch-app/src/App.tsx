import { useEffect, useRef, useState } from "react";
import SetupView from "./components/SetupView";
import RunView from "./components/RunView";
import { cancelSession, exportSession, getSummary, listFiles, onDone, onProgress, pickSavePath } from "./api";
import type { FileRow, Progress, StartOpts, StartResult, Summary } from "./types";

export default function App() {
  const [view, setView] = useState<"setup" | "run">("setup");
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
    const iv = setInterval(() => {
      listFiles(opts.outputDir, start.session_id).then(setRows).catch(() => {});
    }, 2000);
    return () => {
      active = false;
      unP?.();
      unD?.();
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

  const handleCancel = () => {
    setCancelled(true);
    cancelSession();
  };

  const doExport = async (fmt: string, completeOnly: boolean) => {
    if (!start || !opts) return;
    const path = await pickSavePath(`events.${fmt}`);
    if (!path) return;
    try {
      const n = await exportSession(opts.outputDir, start.session_id, path, fmt, completeOnly);
      setNotice(`Exported ${n} rows to ${path}`);
    } catch (e) {
      setNotice(`Export failed: ${String(e)}`);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 1040, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0, fontWeight: 700, letterSpacing: "-0.02em" }}>Acoustic Analysis Dashboard</h1>
      {view === "setup" && <SetupView onStarted={onStarted} />}
      {view === "run" && start && (
        <>
          <button style={{ marginBottom: 12, fontSize: 13, background: "none", border: "none", padding: 0, color: "#9aa0aa" }} disabled={summary === null && !cancelled} onClick={() => setView("setup")}>
            ← Start New Session
          </button>
          {notice && <div style={{ marginBottom: 12, color: "#34d399", fontSize: 13 }}>{notice}</div>}
          <RunView
            start={start}
            progress={progress}
            summary={summary}
            rows={rows}
            throughput={throughput}
            onExport={doExport}
            onCancel={handleCancel}
          />
        </>
      )}
    </main>
  );
}
