import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { checkHealth, pickFile, pickFolder, prepareSystem, startSession, openExistingSession, checkCache, getConcurrencySuggestion, getFeatureFlags } from "../api";
import type { StartOpts, StartResult, HealthStatus, Summary } from "../types";
import ManageCache from "./ManageCache";

const SURAL_PRESETS = [
  { label: 'Sural 2025 Low Elevation (PSL1–PSL9)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/Low' },
  { label: 'Sural 2025 Mid Elevation (PSM2–PSM10)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/Mid' },
  { label: 'Sural 2025 High Elevation (PSH1–PSH10)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/2025/High' },
  { label: 'Sural 2024 High Elevation (PSH Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/High_elevation' },
  { label: 'Sural 2024 Low Elevation (PSL Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/Low_elevation' },
  { label: 'Sural 2024 Mid Elevation (PSM Root)', path: '/Users/leyangloh/Library/CloudStorage/Dropbox-GaTech/Le Yang Loh/Sural_AudioMoths/Mid_elevation' },
];

interface Props {
  onStarted: (result: StartResult, opts: StartOpts, initialSummary?: Summary | null) => void;
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
  const [cacheResult, setCacheResult] = useState<{ input: string; hasCache: boolean } | null>(null);
  const [thetaA, setThetaA] = useState(0); // Sensitivity
  const [thetaB, setThetaB] = useState(0.530306); // Quality
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showTarget, setShowTarget] = useState(false);

  // Analysis target. Blank means "use the pipeline default" — never send a guess.
  const [speciesName, setSpeciesName] = useState("");
  const [fMinHz, setFMinHz] = useState("");
  const [fMaxHz, setFMaxHz] = useState("");
  const [localizer, setLocalizer] = useState("");
  const [classifier, setClassifier] = useState("");
  const [classifierC, setClassifierC] = useState("");
  
  // Advanced (Hidden)
  const [device, setDevice] = useState("cpu");
  const [concurrency, setConcurrency] = useState("1");
  const [logicalCores, setLogicalCores] = useState<number | null>(null);
  const [recommendedConcurrency, setRecommendedConcurrency] = useState<number | null>(null);
  const [featureFlags, setFeatureFlags] = useState<Record<string, boolean> | null>(null);
  const [workerCmd, setWorkerCmd] = useState("uv run python scripts/ml_engine.py --worker");
  const [cwd, setCwd] = useState("");
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [maxAttempts, setMaxAttempts] = useState(2);
  
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deviceWasSelected = useRef(false);
  const cacheRequestId = useRef(0);
  const healthRequestId = useRef(0);
  const inputRef = useRef(input);
  useEffect(() => { inputRef.current = input; }, [input]);
  const updateInput = useCallback((value: string) => {
    inputRef.current = value;
    setInput(value);
  }, []);

  useEffect(() => {
    let active = true;
    const requestId = ++healthRequestId.current;
    checkHealth(cwd || undefined, {
      localizer: localizer.trim() || null,
      classifier: classifier.trim() || null,
      classifierC: classifierC.trim() || null,
    }).then(h => {
      if (!active || healthRequestId.current !== requestId) return;
      setHealth(h);
      if (h?.internal_device && !deviceWasSelected.current) {
        setDevice(h.internal_device);
      }
    }).catch(() => { if (active && healthRequestId.current === requestId) setHealth(null); });
    return () => { active = false; };
  }, [cwd, localizer, classifier, classifierC]);

  useEffect(() => {
    let active = true;
    // Fetch concurrency suggestion for the selected processor
    getConcurrencySuggestion(device).then(info => {
      if (!active) return;
      setLogicalCores(info.logical);
      setRecommendedConcurrency(info.recommended);
    }).catch(() => {
      if (!active) return;
      setLogicalCores(null);
      setRecommendedConcurrency(null);
    });
    // fetch feature flags
    getFeatureFlags(cwd || undefined).then(f => {
      if (active) setFeatureFlags(f || {});
    }).catch(() => { if (active) setFeatureFlags({}); });
    return () => { active = false; };
  }, [device, cwd]);

  const refreshCache = useCallback((path: string) => {
    const requestId = ++cacheRequestId.current;
    if (!path) {
      queueMicrotask(() => {
        if (cacheRequestId.current === requestId) setCacheResult(null);
      });
      return;
    }
    checkCache(path)
      .then((hasCache) => {
        if (cacheRequestId.current === requestId) setCacheResult({ input: path, hasCache });
      })
      .catch(() => {
        if (cacheRequestId.current === requestId) setCacheResult({ input: path, hasCache: false });
      });
  }, []);

  useEffect(() => {
    refreshCache(input);
    return () => { cacheRequestId.current += 1; };
  }, [input, refreshCache]);

  const hasCache = cacheResult?.input === input && cacheResult.hasCache;

  const handlePrepare = async () => {
    const requestId = ++healthRequestId.current;
    setBusy(true);
    try {
      await prepareSystem(cwd || undefined);
      const h = await checkHealth(cwd || undefined, {
        localizer: localizer.trim() || null,
        classifier: classifier.trim() || null,
        classifierC: classifierC.trim() || null,
      });
      if (healthRequestId.current !== requestId) return;
      setHealth(h);
      if (h?.internal_device && !deviceWasSelected.current) {
        setDevice(h.internal_device);
      }
    } catch (e) {
      if (healthRequestId.current === requestId) setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const viewExisting = async () => {
    if (!input) { setError("Please select a recording folder with saved results."); return; }
    setBusy(true);
    setError(null);
    try {
      const data = await openExistingSession(input);
      onStarted(data.start, data.opts, data.summary);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  const optionalNumber = (raw: string): number | null => {
    const trimmed = raw.trim();
    if (trimmed === "") return null;
    const value = Number(trimmed);
    return Number.isFinite(value) ? value : null;
  };

  const start = async () => {
    if (!input) { setError("Please select a recording folder."); return; }
    const fMin = optionalNumber(fMinHz);
    const fMax = optionalNumber(fMaxHz);
    if ((fMinHz.trim() && fMin === null) || (fMaxHz.trim() && fMax === null)) {
      setError("Frequency bounds must be valid numbers or left blank.");
      return;
    }
    if ((fMin !== null && fMin < 0) || (fMax !== null && fMax <= 0)) {
      setError("Frequency bounds must be positive (the low bound may be zero).");
      return;
    }
    if (fMin !== null && fMax !== null && fMin >= fMax) {
      setError("Frequency band is empty: the low bound must be below the high bound.");
      return;
    }
    setBusy(true);
    const concurrencyNum = concurrency.trim() === "" ? 0 : Number(concurrency);
    if (![thetaA, thetaB].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
      setError("Detection and quality thresholds must be between 0 and 1.");
      setBusy(false);
      return;
    }
    if (!Number.isInteger(concurrencyNum) || concurrencyNum < 0) {
      setError("Parallel tasks must be a non-negative whole number (0 selects automatic).");
      setBusy(false);
      return;
    }
    if (!Number.isFinite(timeoutSecs) || timeoutSecs <= 0 || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
      setError("Timeout must be positive and the retry limit must be a positive whole number.");
      setBusy(false);
      return;
    }
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
      speciesName: speciesName.trim() || null,
      fMinHz: fMin,
      fMaxHz: fMax,
      localizer: localizer.trim() || null,
      classifier: classifier.trim() || null,
      classifierC: classifierC.trim() || null,
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
  // Until the first health probe answers we know nothing; don't flash the red "setup required" state.
  const checking = health === null;

  return (
    <div className="card reveal" style={{ display: "grid", gap: 22, maxWidth: 660, "--d": "0.06s" } as CSSProperties}>
      {/* Health Panel */}
      <div className={`health ${ready ? "health--ok" : checking ? "" : "health--bad"}`}>
        <div>
          <div className="health__title">
            {checking
              ? <span className="loading-spinner" style={{ width: 12, height: 12, borderWidth: 2 }} />
              : <span className={`dot ${ready ? "dot--ok" : "dot--bad"}`} />}
            {ready ? "Instrument ready to listen" : checking ? "Checking instrument…" : "Setup required before listening"}
          </div>
          <div className="health__meta">
            engine {health?.device || "checking…"} · models {checking ? "checking…" : health?.models_ok ? "loaded" : "missing"}
          </div>
        </div>
        {!ready && !checking && (
          <button className="primary" onClick={handlePrepare} disabled={busy}>
            {busy ? (
              <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
                Preparing…
              </span>
            ) : "Prepare System"}
          </button>
        )}
      </div>

      <Field label={<><span className="section-num">1</span>Select recording folder</>}>
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={input} readOnly placeholder="Browse to a folder of field recordings…" />
          <button onClick={async () => { const f = await pickFolder(); if(f) updateInput(f); }}>Browse…</button>
        </div>
        <div style={{ marginTop: '8px' }}>
          <label style={{ fontSize: '0.85rem', color: 'var(--text-faint)' }}>Quick Sural Dataset Preset:</label>
          <select
            className="select-input"
            style={{ marginTop: '4px', width: '100%' }}
            value={SURAL_PRESETS.some((preset) => preset.path === input) ? input : ""}
            onChange={(e) => {
              if (e.target.value) {
                updateInput(e.target.value);
              }
            }}
          >
            <option value="">Select a Sural AudioMoth deployment folder...</option>
            {SURAL_PRESETS.map((p) => (
              <option key={p.path} value={p.path}>{p.label}</option>
            ))}
          </select>
        </div>
        {hasCache && (
          <ManageCache
            outputDir={input}
            onCleared={(clearedDir) => {
              if (inputRef.current !== clearedDir) return;
              refreshCache(clearedDir);
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
        <button className="disclosure" aria-expanded={showTarget} onClick={() => setShowTarget(!showTarget)}>
          <span className="chev">{showTarget ? "▼" : "▶"}</span> Analysis target
        </button>
        {showTarget && (
          <div className="internals">
            <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
              Leave blank to analyse the Hume's Leaf Warbler buzz with the bundled models.
              Override these to run the same pipeline on a different species or call type.
            </div>
            <Field label="Species / call type" hint="recorded with the session">
              <input value={speciesName} placeholder="Hume's Leaf Warbler"
                onChange={e => setSpeciesName(e.target.value)} />
            </Field>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Field label="Band low (Hz)" hint="default 4125">
                <input type="number" value={fMinHz} placeholder="4125"
                  onChange={e => setFMinHz(e.target.value)} />
              </Field>
              <Field label="Band high (Hz)" hint="default 11625">
                <input type="number" value={fMaxHz} placeholder="11625"
                  onChange={e => setFMaxHz(e.target.value)} />
              </Field>
            </div>
            {([
              ["Stage A detector", localizer, setLocalizer, "models/buzz_localizer.pt"],
              ["Stage B completeness", classifier, setClassifier, "models/classifier.pt"],
              ["Stage C classifier", classifierC, setClassifierC, "(none)"],
            ] as const).map(([label, value, setter, placeholder]) => (
              <Field key={label} label={label}>
                <div style={{ display: "flex", gap: 8 }}>
                  <input style={{ flex: 1 }} value={value} placeholder={placeholder}
                    onChange={e => setter(e.target.value)} />
                  <button onClick={async () => {
                    const f = await pickFile([{ name: "Model weights", extensions: ["pt", "pth", "onnx"] }]);
                    if (f) setter(f);
                  }}>Browse…</button>
                  {value && <button onClick={() => setter("")}>Reset</button>}
                </div>
              </Field>
            ))}
          </div>
        )}
      </div>

      <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16 }}>
        {featureFlags?.advanced_settings !== false && (
          <>
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
                    <select value={device} onChange={e => {
                      deviceWasSelected.current = true;
                      setDevice(e.target.value);
                    }}>
                      <option value="cpu">System Processor (CPU)</option>
                      <option value="cuda">NVIDIA Graphics Card (CUDA)</option>
                      <option value="mps">Apple Silicon (MPS)</option>
                    </select>
                 </Field>
                 <Field label="Execution directory"><input value={cwd} placeholder="(Default)" onChange={e => setCwd(e.target.value)} /></Field>
                 <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                   {featureFlags?.parallel_control !== false && (
                     <Field
                       label="Parallel tasks"
                       hint={recommendedConcurrency ? `Auto: ${recommendedConcurrency} (recommended)` : undefined}
                     >
                       <input
                         type="number"
                         value={concurrency}
                         onChange={e => setConcurrency(e.target.value)}
                       />
                     </Field>
                   )}
                   {recommendedConcurrency !== null && featureFlags?.parallel_control !== false && (() => {
                     const cnum = concurrency.trim() === "" ? 0 : Number(concurrency);
                     return cnum > 0 && cnum > recommendedConcurrency ? (
                       <div className="error-text" style={{ gridColumn: "span 3" }}>Warning: using {cnum} parallel tasks exceeds the recommended {recommendedConcurrency} for this machine ({logicalCores ?? 'unknown'} logical cores). This may fully saturate the system.</div>
                     ) : null;
                   })()}
                   <Field label="Timeout (s)"><input type="number" value={timeoutSecs} onChange={e => setTimeoutSecs(Number(e.target.value))} /></Field>
                   <Field label="Retry limit"><input type="number" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} /></Field>
                 </div>
              </div>
            )}
          </>
        )}
      </div>

      {error && <div className="error-text">{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: hasCache ? "1fr 1fr" : "1fr", gap: 12 }}>
        {hasCache && (
          <button
            type="button"
            className="backlink"
            style={{
              height: 52,
              fontSize: 14,
              fontWeight: 600,
              border: "1px solid var(--line-2)",
              background: "var(--surface)",
              borderRadius: "var(--radius)",
              color: "var(--text)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              cursor: "pointer",
            }}
            disabled={busy}
            onClick={viewExisting}
          >
            📂 View Existing Results
          </button>
        )}
        <button
          className="primary"
          style={{ height: 52, fontSize: 15, letterSpacing: "0.01em" }}
          disabled={busy || !ready}
          onClick={start}
        >
          {busy ? (
            <span style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
              <span className="loading-spinner" style={{ width: 14, height: 14, borderWidth: 2 }} />
              Initializing…
            </span>
          ) : hasCache ? "Re-run / Resume Batch →" : "Begin Listening →"}
        </button>
      </div>
    </div>
  );
}
