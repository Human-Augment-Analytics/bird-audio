import { useEffect, useRef, useState } from "react";
import SetupView from "./components/SetupView";
import RunView from "./components/RunView";
import { exportSession, listFiles, onDone, onProgress, pickSavePath } from "./api";
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
  const tRef = useRef<{ t: number; done: number } | null>(null);

  useEffect(() => {
    if (view !== "run" || !start || !opts) return;
    let unP: (() => void) | undefined;
    let unD: (() => void) | undefined;
    onProgress((p) => {
      setProgress(p);
      const now = Date.now();
      const prev = tRef.current;
      if (prev && now > prev.t) {
        const rate = ((p.done - prev.done) * 1000) / (now - prev.t);
        setThroughput((cur) => (cur === 0 ? Math.max(rate, 0) : cur * 0.7 + Math.max(rate, 0) * 0.3));
      }
      tRef.current = { t: now, done: p.done };
    }).then((u) => (unP = u));
    onDone((s) => {
      setSummary(s);
      listFiles(opts.output_dir, start.session_id).then(setRows).catch(() => {});
    }).then((u) => (unD = u));
    const iv = setInterval(() => {
      listFiles(opts.output_dir, start.session_id).then(setRows).catch(() => {});
    }, 2000);
    return () => {
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
    tRef.current = null;
    setView("run");
  };

  const doExport = async (fmt: string, completeOnly: boolean) => {
    if (!start || !opts) return;
    const path = await pickSavePath(`events.${fmt}`);
    if (!path) return;
    try {
      const n = await exportSession(opts.output_dir, start.session_id, path, fmt, completeOnly);
      setNotice(`Exported ${n} rows to ${path}`);
    } catch (e) {
      setNotice(`Export failed: ${String(e)}`);
    }
  };

  return (
    <main style={{ padding: 24, maxWidth: 1040, margin: "0 auto" }}>
      <h1 style={{ marginTop: 0 }}>Bird Batch Runner</h1>
      {view === "setup" && <SetupView onStarted={onStarted} />}
      {view === "run" && start && (
        <>
          <button style={{ marginBottom: 12 }} disabled={summary === null} onClick={() => setView("setup")}>
            ← New session
          </button>
          {notice && <div style={{ marginBottom: 12, color: "#34d399", fontSize: 13 }}>{notice}</div>}
          <RunView
            start={start}
            progress={progress}
            summary={summary}
            rows={rows}
            throughput={throughput}
            onExport={doExport}
          />
        </>
      )}
    </main>
  );
}
