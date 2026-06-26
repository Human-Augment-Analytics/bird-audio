import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { checkHealth, pickFolder, prepareSystem, startSession, checkCache, getConcurrencySuggestion, getFeatureFlags } from "../api";
import type { StartOpts, StartResult, HealthStatus } from "../types";
import ManageCache from "./ManageCache";

interface Props {
  onStarted: (result: StartResult, opts: StartOpts) => void;
}

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

export default function SetupView({ onStarted }: Props) {
  const [input, setInput] = useState("");
  const [hasCache, setHasCache] = useState(false);
  const [thetaA, setThetaA] = useState(0); // Sensitivity
  const [thetaB, setThetaB] = useState(0.530306); // Quality
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  // Advanced (Hidden)
  const [device, setDevice] = useState("cpu");
  const [concurrency, setConcurrency] = useState("1");
  const [logicalCores, setLogicalCores] = useState<number | null>(null);
  const [recommendedConcurrency, setRecommendedConcurrency] = useState<number | null>(null);
  const [featureFlags, setFeatureFlags] = useState<Record<string, any> | null>(null);
  const [workerCmd, setWorkerCmd] = useState("uv run python scripts/ml_engine.py --worker");
  const [cwd, setCwd] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [maxAttempts, setMaxAttempts] = useState(2);
  
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    checkHealth(cwd || undefined).then(h => {
      setHealth(h);
      if (h?.internal_device) {
        setDevice(h.internal_device);
      }
    }).catch(() => setHealth(null));
  }, [cwd]);

  useEffect(() => {
    // Fetch concurrency suggestion for the selected processor
    getConcurrencySuggestion(device).then(info => {
      setLogicalCores(info.logical);
      setRecommendedConcurrency(info.recommended);
    }).catch(() => {
      setLogicalCores(null);
      setRecommendedConcurrency(null);
    });
    // fetch feature flags
    getFeatureFlags(cwd || undefined).then(f => {
      setFeatureFlags(f || {});
    }).catch(() => setFeatureFlags({}));
  }, [device, cwd]);

  useEffect(() => {
    if (input) {
      checkCache(input).then(setHasCache).catch(() => setHasCache(false));
    } else {
      setHasCache(false);
    }
  }, [input]);

  const handlePrepare = async () => {
    setBusy(true);
    try {
      await prepareSystem(cwd || undefined);
      const h = await checkHealth(cwd || undefined);
      setHealth(h);
      if (h?.internal_device) {
        setDevice(h.internal_device);
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!input) { setError("Please select a recording folder."); return; }
    setBusy(true);
    const concurrencyNum = concurrency.trim() === "" ? 0 : Number(concurrency);
    const opts: StartOpts = {
      input,
      outputDir: input,
      device,
      concurrency: concurrencyNum,
      workerCmd,
      cwd: cwd.trim() || null,
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

  const ready = health?.env_ok && health?.models_ok;

  return (
    <div className="card reveal" style={{ display: "grid", gap: 22, maxWidth: 660, "--d": "0.06s" } as CSSProperties}>
      {/* Health Panel */}
      <div className={`health ${ready ? "health--ok" : "health--bad"}`}>
        <div>
          <div className="health__title">
            <span className={`dot ${ready ? "dot--ok" : "dot--bad"}`} />
            {ready ? "Instrument ready to listen" : "Setup required before listening"}
          </div>
          <div className="health__meta">
            engine {health?.device || "checking…"} · models {health?.models_ok ? "loaded" : "missing"}
          </div>
        </div>
        {!ready && (
          <button className="primary" onClick={handlePrepare} disabled={busy}>
            {busy ? "Preparing…" : "Prepare System"}
          </button>
        )}
      </div>

      <Field label={<><span className="section-num">1</span>Select recording folder</>}>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={input} readOnly placeholder="Browse to a folder of field recordings…" />
          <button onClick={async () => { const f = await pickFolder(); if(f) setInput(f); }}>Browse…</button>
        </div>
        {hasCache && (
          <ManageCache
            outputDir={input}
            onCleared={() => {
              checkCache(input).then(setHasCache).catch(() => setHasCache(false));
              setError("Selected results cleared from cache.");
            }}
          />
        )}
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label={<><span className="section-num">2</span>Detection sensitivity</>} hint="lower = more buzzes">
          <input type="number" step="0.01" value={thetaA} onChange={e => setThetaA(Number(e.target.value))} />
        </Field>
        <Field label={<><span className="section-num">3</span>Quality filter</>} hint="higher = stricter">
          <input type="number" step="0.01" value={thetaB} onChange={e => setThetaB(Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        <button
          className="disclosure"
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          <span className="chev">▶</span> System internals
        </button>

        {showAdvanced && (
          <div className="internals">
             <Field label="Worker process command"><input value={workerCmd} onChange={e => setWorkerCmd(e.target.value)} /></Field>
             <Field label="Processing engine">
                <select value={device} onChange={e => setDevice(e.target.value)}>
                  <option value="cpu">System Processor (CPU)</option>
                  <option value="cuda">NVIDIA Graphics Card (CUDA)</option>
                  <option value="mps">Apple Silicon (MPS)</option>
                </select>
             </Field>
             <Field label="Execution directory"><input value={cwd} placeholder="(Default)" onChange={e => setCwd(e.target.value)} /></Field>
             <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
               <Field
                 label="Parallel tasks"
                 hint={featureFlags && featureFlags.parallel_control === false ? "Locked by system policy" : (recommendedConcurrency ? `Auto: ${recommendedConcurrency} (recommended)` : undefined)}
               >
                 <input
                   type="number"
                   value={concurrency}
                   onChange={e => setConcurrency(e.target.value)}
                   disabled={featureFlags?.parallel_control === false}
                 />
               </Field>
               {recommendedConcurrency !== null && (() => {
                 const cnum = concurrency.trim() === "" ? 0 : Number(concurrency);
                 return cnum > 0 && cnum > recommendedConcurrency ? (
                   <div className="error-text">Warning: using {cnum} parallel tasks exceeds the recommended {recommendedConcurrency} for this machine ({logicalCores ?? 'unknown'} logical cores). This may fully saturate the system.</div>
                 ) : null;
               })()}
               <Field label="Timeout (s)"><input type="number" value={timeoutSecs} onChange={e => setTimeoutSecs(Number(e.target.value))} /></Field>
               <Field label="Retry limit"><input type="number" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} /></Field>
             </div>
          </div>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}

      <button className="primary" style={{ height: 52, fontSize: 15, letterSpacing: "0.01em" }} disabled={busy || !ready} onClick={start}>
        {busy ? "Initializing…" : "Begin Listening →"}
      </button>
    </div>
  );
}
