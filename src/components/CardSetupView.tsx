import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import {
  checkHealth, clearCache, countAudioFiles, getCachedFiles, getConcurrencySuggestion,
  getFeatureFlags, pickFolder, prepareSystem, startSession,
} from "../api";
import type { StartOpts, StartResult, HealthStatus } from "../types";
import birdImg from "../assets/hero.png";

interface Props {
  onStarted: (result: StartResult, opts: StartOpts) => void;
}

const DEFAULT_SENSITIVITY = 0;
const DEFAULT_QUALITY = 0.530306;
const RATE_KEY = "birdaudio.secPerFile"; // seconds per recording, saved after each finished run

type Step = "folder" | "resume" | "options" | "analyze";

function Field({ label, children, hint }: { label: ReactNode; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <div className="field-head">
        <span className="field-label">{label}</span>
        {hint && <span className="field-hint">{hint}</span>}
      </div>
      {children}
    </label>
  );
}

function BackButton({ onClick, label = "← Back" }: { onClick: () => void; label?: string }) {
  return (
    <button
      onClick={onClick}
      style={{
        background: "none",
        border: "1px solid var(--line-2)",
        borderRadius: "var(--radius-sm)",
        color: "var(--text-dim)",
        fontSize: 13,
        padding: "8px 18px",
        cursor: "pointer",
        transition: "border-color 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => { (e.target as HTMLElement).style.borderColor = "var(--amber)"; (e.target as HTMLElement).style.color = "var(--text)"; }}
      onMouseLeave={(e) => { (e.target as HTMLElement).style.borderColor = "var(--line-2)"; (e.target as HTMLElement).style.color = "var(--text-dim)"; }}
    >
      {label}
    </button>
  );
}

/* "about 2 hours", "about 45 minutes", "under a minute" */
function fmtDuration(totalSecs: number): string {
  if (totalSecs < 60) return "under a minute";
  const mins = Math.round(totalSecs / 60);
  if (mins < 60) return `about ${mins} minute${mins === 1 ? "" : "s"}`;
  const hrs = mins / 60;
  const rounded = Math.round(hrs * 2) / 2; // nearest half hour
  return `about ${rounded} hour${rounded === 1 ? "" : "s"}`;
}

export default function CardSetupView({ onStarted }: Props) {
  const [step, setStep] = useState<Step>("folder");
  const [flags, setFlags] = useState<Record<string, any> | null>(null);
  const [input, setInput] = useState("");
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [alreadyDone, setAlreadyDone] = useState(0);
  const [thetaA, setThetaA] = useState(DEFAULT_SENSITIVITY);
  const [thetaB, setThetaB] = useState(DEFAULT_QUALITY);
  const [health, setHealth] = useState<HealthStatus | null>(null);

  // Advanced (only reachable when the advanced_settings flag is on)
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [device, setDevice] = useState("cpu");
  const [concurrency, setConcurrency] = useState("");
  const [recommendedConcurrency, setRecommendedConcurrency] = useState<number | null>(null);
  const [workerCmd, setWorkerCmd] = useState("uv run python scripts/ml_engine.py --worker");
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [maxAttempts, setMaxAttempts] = useState(2);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getFeatureFlags().then((f) => setFlags(f || {})).catch(() => setFlags({}));
    checkHealth().then((h) => {
      setHealth(h);
      if (h?.internal_device) setDevice(h.internal_device);
    }).catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    getConcurrencySuggestion(device)
      .then((info) => setRecommendedConcurrency(info.recommended))
      .catch(() => setRecommendedConcurrency(null));
  }, [device]);

  const ready = health?.env_ok && health?.models_ok;
  const advancedEnabled = flags?.advanced_settings === true;
  const resumeEnabled = flags?.resume_runs !== false;
  const estimatesEnabled = flags?.time_estimates !== false;
  const cloudHintEnabled = flags?.cloud_import === true;

  const secPerFile = (() => {
    const v = Number(localStorage.getItem(RATE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  })();
  const remaining = fileCount !== null ? Math.max(fileCount - alreadyDone, 0) : null;
  const estimate = estimatesEnabled && secPerFile && remaining ? fmtDuration(remaining * secPerFile) : null;

  const handleChooseFolder = async () => {
    setError(null);
    const f = await pickFolder();
    if (!f) return; // user cancelled the dialog — stay put, nothing changes
    setInput(f);
    const [count, cached] = await Promise.all([
      countAudioFiles(f).catch(() => null),
      getCachedFiles(f).catch(() => []),
    ]);
    setFileCount(count);
    const doneCount = cached.filter((c) => c.status === "done").length;
    setAlreadyDone(doneCount);
    if (count === 0) {
      setError("We couldn't find any audio recordings in that folder. Try choosing the folder that contains your recordings directly.");
      return;
    }
    setStep(resumeEnabled && doneCount > 0 ? "resume" : "options");
  };

  const handleStartOver = async () => {
    setBusy(true);
    try {
      await clearCache(input);
      setAlreadyDone(0);
      setStep("options");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handlePrepare = async () => {
    setBusy(true);
    try {
      await prepareSystem();
      const h = await checkHealth();
      setHealth(h);
      if (h?.internal_device) setDevice(h.internal_device);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleAnalyze = async () => {
    setBusy(true);
    setError(null);
    const concurrencyNum = concurrency.trim() === "" ? 0 : Number(concurrency);
    const opts: StartOpts = {
      input,
      outputDir: input,
      device,
      concurrency: concurrencyNum,
      workerCmd,
      cwd: null,
      thetaA,
      thetaB,
      timeoutSecs,
      maxAttempts,
    };
    try {
      const result = await startSession(opts);
      onStarted(result, opts);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const folderName = input.split("/").pop() || input;

  return (
    <div className="card reveal" style={{ display: "grid", gap: 22, maxWidth: 560, margin: "0 auto", "--d": "0.06s" } as CSSProperties}>

      {/* ── Step 1: choose folder ─────────────────────────────────────── */}
      {step === "folder" && (
        <div style={{ display: "grid", gap: 16, textAlign: "center", padding: "20px 8px" }}>
          <h2 style={{ margin: 0 }}>Choose the folder your audio files are in</h2>
          <p className="sub" style={{ margin: 0 }}>
            This app listens through your field recordings and marks every place it
            hears a buzz, so you can review them instead of listening to hours of audio.
          </p>
          <button className="primary" style={{ height: 52, fontSize: 15, justifySelf: "center", minWidth: 220 }} onClick={handleChooseFolder}>
            Choose folder…
          </button>
          {cloudHintEnabled && (
            <p className="sub" style={{ margin: 0, fontSize: 12 }}>
              Recordings in OneDrive? Choose your OneDrive folder on this computer
              (the one that syncs automatically) — it works just like any other folder.
            </p>
          )}
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {/* ── Step 1b: earlier progress found ───────────────────────────── */}
      {step === "resume" && (
        <div style={{ display: "grid", gap: 16, textAlign: "center", padding: "12px 8px" }}>
          <h2 style={{ margin: 0 }}>Welcome back!</h2>
          <p className="sub" style={{ margin: 0 }}>
            It looks like you've worked on this folder before. Your earlier progress was saved:
            {" "}<b>{alreadyDone}</b> of <b>{fileCount}</b> recordings are already analyzed.
          </p>
          <button className="primary" style={{ height: 52, fontSize: 15 }} onClick={() => setStep("options")}>
            Pick up where I left off
          </button>
          <p className="sub" style={{ margin: 0, fontSize: 12 }}>
            Recordings that are already finished will be skipped, so this will be faster.
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 10 }}>
            <BackButton onClick={() => setStep("folder")} label="← Different folder" />
            <BackButton onClick={handleStartOver} label={busy ? "Clearing…" : "Erase progress and start over"} />
          </div>
          {error && <div className="error-text">{error}</div>}
        </div>
      )}

      {/* ── Step 2: settings ──────────────────────────────────────────── */}
      {step === "options" && (
        <div style={{ display: "grid", gap: 18 }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ margin: 0 }}>Set detection sensitivity and quality filter</h2>
            <p className="sub" style={{ margin: "8px 0 0" }}>
              These are the recommended settings — most people can continue without changing anything.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <Field label="Detection sensitivity" hint="lower = more buzzes">
              <input type="number" step="0.01" value={thetaA} onChange={(e) => setThetaA(Number(e.target.value))} />
            </Field>
            <Field label="Quality filter" hint="higher = stricter">
              <input type="number" step="0.01" value={thetaB} onChange={(e) => setThetaB(Number(e.target.value))} />
            </Field>
          </div>
          <p className="sub" style={{ margin: 0, fontSize: 12 }}>
            Higher sensitivity finds more possible buzzes but includes more false alarms;
            a stricter quality filter keeps only the clearest ones. You can always re-run
            this folder later with different settings.
          </p>
          {(thetaA !== DEFAULT_SENSITIVITY || thetaB !== DEFAULT_QUALITY) && (
            <button
              className="backlink"
              style={{ justifySelf: "start" }}
              onClick={() => { setThetaA(DEFAULT_SENSITIVITY); setThetaB(DEFAULT_QUALITY); }}
            >
              ↺ Reset to recommended
            </button>
          )}

          {advancedEnabled && (
            <div style={{ borderTop: "1px solid var(--line)", paddingTop: 14 }}>
              <button className="disclosure" aria-expanded={showAdvanced} onClick={() => setShowAdvanced(!showAdvanced)}>
                <span className="chev">▶</span> Advanced settings (optional)
              </button>
              {showAdvanced && (
                <div className="internals">
                  <Field label="Processing engine">
                    <select value={device} onChange={(e) => setDevice(e.target.value)}>
                      <option value="cpu">System Processor (CPU)</option>
                      <option value="cuda">NVIDIA Graphics Card (CUDA)</option>
                      <option value="mps">Apple Silicon (MPS)</option>
                    </select>
                  </Field>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    {flags?.parallel_control !== false && (
                      <Field
                        label="Parallel tasks"
                        hint={recommendedConcurrency ? `Auto: ${recommendedConcurrency}` : undefined}
                      >
                        <input type="number" value={concurrency} placeholder="Auto" onChange={(e) => setConcurrency(e.target.value)} />
                      </Field>
                    )}
                    <Field label="Timeout (s)"><input type="number" value={timeoutSecs} onChange={(e) => setTimeoutSecs(Number(e.target.value))} /></Field>
                    <Field label="Retry limit"><input type="number" value={maxAttempts} onChange={(e) => setMaxAttempts(Number(e.target.value))} /></Field>
                  </div>
                  <Field label="Worker process command"><input value={workerCmd} onChange={(e) => setWorkerCmd(e.target.value)} /></Field>
                </div>
              )}
            </div>
          )}

          <button className="primary" style={{ height: 48 }} onClick={() => setStep("analyze")}>Continue →</button>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BackButton onClick={() => setStep(resumeEnabled && alreadyDone > 0 ? "resume" : "folder")} />
          </div>
        </div>
      )}

      {/* ── Step 3: analyze ───────────────────────────────────────────── */}
      {step === "analyze" && (
        <div style={{ display: "grid", gap: 16, textAlign: "center", padding: "12px 8px" }}>
          <img
            src={birdImg}
            alt=""
            aria-hidden="true"
            style={{ width: 140, height: "auto", justifySelf: "center", borderRadius: 14 }}
          />
          <h2 style={{ margin: 0 }}>Ready to analyze!</h2>
          <p className="sub" style={{ margin: 0 }}>
            {remaining !== null ? (
              <>
                We'll listen through <b>{remaining}</b> recording{remaining === 1 ? "" : "s"} in <b>{folderName}</b>
                {alreadyDone > 0 && <> ({alreadyDone} already finished earlier)</>}.
              </>
            ) : (
              <>We'll listen through every recording in <b>{folderName}</b>.</>
            )}
          </p>
          <p className="sub" style={{ margin: 0, fontSize: 12 }}>
            {estimate ? (
              <>Based on your last run, this should take {estimate}. You'll see live progress the whole time,
              and you can safely close the app — your progress is saved as it goes.</>
            ) : (
              <>You'll see a time estimate shortly after the analysis starts, plus live progress the whole time.
              You can safely close the app — your progress is saved as it goes.</>
            )}
          </p>

          {!ready && (
            <div className="health health--bad" style={{ textAlign: "left" }}>
              <div>
                <div className="health__title">
                  <span className="dot dot--bad" />
                  One-time setup needed first
                </div>
                <div className="health__meta">engine {health?.device || "checking…"}</div>
              </div>
              <button className="primary" onClick={handlePrepare} disabled={busy}>
                {busy ? (
                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                    Preparing…
                  </span>
                ) : "Prepare System"}
              </button>
            </div>
          )}

          {error && <div className="error-text">{error}</div>}

          <button
            className="primary"
            style={{ height: 52, fontSize: 15, letterSpacing: "0.01em" }}
            disabled={busy || !ready}
            onClick={handleAnalyze}
          >
            {busy ? (
              <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                Starting…
              </span>
            ) : "Analyze!"}
          </button>
          <div style={{ display: "flex", justifyContent: "center" }}>
            <BackButton onClick={() => setStep("options")} label="← Back to settings" />
          </div>
        </div>
      )}
    </div>
  );
}
