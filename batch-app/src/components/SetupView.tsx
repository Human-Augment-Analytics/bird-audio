import { useEffect, useState, type ReactNode } from "react";
import { checkHealth, pickFolder, prepareSystem, startSession, checkCache } from "../api";
import type { StartOpts, StartResult, HealthStatus } from "../types";
import ManageCache from "./ManageCache";

interface Props {
  onStarted: (result: StartResult, opts: StartOpts) => void;
}

function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontWeight: 600 }}>{label}</span>
        {hint && <span style={{ color: "#9aa0aa", fontSize: 11 }}>{hint}</span>}
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
  const [concurrency, setConcurrency] = useState(0);
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
    });
  }, [cwd]);

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
    const opts: StartOpts = {
      input, outputDir: input, device, concurrency, workerCmd,
      cwd: cwd.trim() || null, thetaA, thetaB, timeoutSecs, maxAttempts,
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
    <div className="card" style={{ display: "grid", gap: 20, maxWidth: 640 }}>
      {/* Health Panel */}
      <div style={{ 
        padding: 16, borderRadius: 8, border: "1px solid #2c2f36",
        background: ready ? "rgba(52, 211, 153, 0.05)" : "rgba(248, 113, 113, 0.05)"
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontSize: 14 }}>
            <strong>System Status:</strong> {ready ? "Ready to process" : "Setup required"}
            <div style={{ fontSize: 12, color: "#9aa0aa", marginTop: 4 }}>
              Engine: {health?.device || "Checking..."} · Models: {health?.models_ok ? "OK" : "Missing"}
            </div>
          </div>
          {!ready && (
            <button className="primary" onClick={handlePrepare} disabled={busy}>
              {busy ? "Preparing..." : "Prepare System"}
            </button>
          )}
        </div>
      </div>

      <Field label="1. Select Recording Folder">
        <div style={{ display: "flex", gap: 8 }}>
          <input style={{ flex: 1 }} value={input} readOnly placeholder="Browse to select folder..." />
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
        <Field label="2. Detection Sensitivity" hint="Lower = more buzzes (thetaA)">
          <input type="number" step="0.01" value={thetaA} onChange={e => setThetaA(Number(e.target.value))} />
        </Field>
        <Field label="3. Quality Threshold" hint="Higher = stricter (thetaB)">
          <input type="number" step="0.01" value={thetaB} onChange={e => setThetaB(Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ borderTop: "1px solid #1f2228", paddingTop: 16, marginTop: 4 }}>
        <button 
          style={{ fontSize: 12, color: "#9aa0aa", padding: 0, background: "none", border: "none", display: "flex", alignItems: "center", gap: 4 }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "▼ Hide System Internals" : "▶ Show System Internals"}
        </button>
        
        {showAdvanced && (
          <div style={{ display: "grid", gap: 12, marginTop: 12, padding: 16, background: "rgba(255,255,255,0.02)", borderRadius: 8, border: "1px solid #1f2228" }}>
             <Field label="Worker Process Command"><input value={workerCmd} onChange={e => setWorkerCmd(e.target.value)} /></Field>
             <Field label="Processing Device">
                <select value={device} onChange={e => setDevice(e.target.value)}>
                  <option value="cpu">System Processor (CPU)</option>
                  <option value="cuda">NVIDIA Graphics Card (CUDA)</option>
                  <option value="mps">Apple Silicon (MPS)</option>
                </select>
             </Field>
             <Field label="Execution Directory"><input value={cwd} placeholder="(Default)" onChange={e => setCwd(e.target.value)} /></Field>
             <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
               <Field label="Parallel Tasks"><input type="number" value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} /></Field>
               <Field label="Timeout (s)"><input type="number" value={timeoutSecs} onChange={e => setTimeoutSecs(Number(e.target.value))} /></Field>
               <Field label="Retry Limit"><input type="number" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} /></Field>
             </div>
          </div>
        )}
      </div>

      {error && <div style={{ color: "#f87171", fontSize: 13 }}>{error}</div>}
      
      <button className="primary" style={{ height: 48, fontSize: 16 }} disabled={busy || !ready} onClick={start}>
        {busy ? "Initializing..." : "Start Batch Processing"}
      </button>
    </div>
  );
}
