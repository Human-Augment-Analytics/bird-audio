import { useEffect, useState, type CSSProperties } from "react";
import { checkHealth, pickFolder, prepareSystem, startSession } from "../api";
import type { StartOpts, StartResult, HealthStatus } from "../types";
import birdImg from "../assets/hero.png";

interface Props {
  onStarted: (result: StartResult, opts: StartOpts) => void;
}

const DEFAULT_SENSITIVITY = 0;
const DEFAULT_QUALITY = 0.530306;

type Step = "folder" | "options" | "analyze";

export default function CardSetupView({ onStarted }: Props) {
  const [step, setStep] = useState<Step>("folder");
  const [input, setInput] = useState("");
  const [thetaA, setThetaA] = useState(DEFAULT_SENSITIVITY);
  const [thetaB, setThetaB] = useState(DEFAULT_QUALITY);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [device, setDevice] = useState("cpu");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkHealth().then((h) => {
      setHealth(h);
      if (h?.internal_device) setDevice(h.internal_device);
    }).catch(() => setHealth(null));
  }, []);

  const ready = health?.env_ok && health?.models_ok;

  const handleChooseFolder = async () => {
    const f = await pickFolder();
    if (f) {
      setInput(f);
      setStep("options");
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
    const opts: StartOpts = {
      input,
      outputDir: input,
      device,
      concurrency: 0,
      workerCmd: "uv run python scripts/ml_engine.py --worker",
      cwd: null,
      thetaA,
      thetaB,
      timeoutSecs: 600,
      maxAttempts: 2,
    };
    try {
      const result = await startSession(opts);
      onStarted(result, opts);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="card reveal" style={{ display: "grid", gap: 22, maxWidth: 520, margin: "0 auto", "--d": "0.06s" } as CSSProperties}>
      {step === "folder" && (
        <div style={{ display: "grid", gap: 16, textAlign: "center", padding: "20px 8px" }}>
          <h2 style={{ margin: 0 }}>Choose the folder your audio files are in</h2>
          <p className="sub" style={{ margin: 0 }}>
            Pick the folder on your computer that has the recordings you want to listen for birds in.
          </p>
          <button className="primary" style={{ height: 52, fontSize: 15, justifySelf: "center", minWidth: 220 }} onClick={handleChooseFolder}>
            Choose folder…
          </button>
        </div>
      )}

      {step === "options" && (
        <div style={{ display: "grid", gap: 18 }}>
          <div style={{ textAlign: "center" }}>
            <h2 style={{ margin: 0 }}>Set detection sensitivity and quality filter</h2>
            <p className="sub" style={{ margin: "8px 0 0" }}>
              We've filled in good defaults — feel free to leave these as they are.
            </p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
            <label className="field">
              <div className="field-head">
                <span className="field-label">Detection sensitivity</span>
                <span className="field-hint">lower = more buzzes</span>
              </div>
              <input type="number" step="0.01" value={thetaA} onChange={(e) => setThetaA(Number(e.target.value))} />
            </label>
            <label className="field">
              <div className="field-head">
                <span className="field-label">Quality filter</span>
                <span className="field-hint">higher = stricter</span>
              </div>
              <input type="number" step="0.01" value={thetaB} onChange={(e) => setThetaB(Number(e.target.value))} />
            </label>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <button className="backlink" onClick={() => setStep("folder")}>← Back</button>
            <button className="primary" onClick={() => setStep("analyze")}>Continue →</button>
          </div>
        </div>
      )}

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
            We'll listen through every recording in the folder you chose.
          </p>

          {!ready && (
            <div className="health health--bad" style={{ textAlign: "left" }}>
              <div>
                <div className="health__title">
                  <span className="dot dot--bad" />
                  Setup required before listening
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
          <button
            onClick={() => setStep("options")}
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
            ← Back to settings
          </button>
        </div>
      )}
    </div>
  );
}
