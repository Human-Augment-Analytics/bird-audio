import { useEffect, useState, type ReactNode } from "react";
import { checkHealth, pickFolder, prepareSystem, startSession } from "../api";
import type { StartOpts, StartResult, HealthStatus } from "../types";

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
    checkHealth(cwd || undefined).then(setHealth);
  }, [cwd]);

  const handlePrepare = async () => {
    setBusy(true);
    try {
      await prepareSystem(cwd || undefined);
      const h = await checkHealth(cwd || undefined);
      setHealth(h);
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
    <div style={{ display: "grid", gap: 20, maxWidth: 640 }}>
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
      </Field>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 }}>
        <Field label="2. Detection Sensitivity" hint="0.0 = Default">
          <input type="number" step="0.01" value={thetaA} onChange={e => setThetaA(Number(e.target.value))} />
        </Field>
        <Field label="3. Quality Filter" hint="0.53 = Default">
          <input type="number" step="0.01" value={thetaB} onChange={e => setThetaB(Number(e.target.value))} />
        </Field>
      </div>

      <div style={{ borderTop: "1px solid #1f2228", paddingTop: 12 }}>
        <button 
          style={{ fontSize: 12, color: "#9aa0aa", padding: 0, background: "none" }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "▼ Hide Internals" : "▶ Show System Internals"}
        </button>
        
        {showAdvanced && (
          <div style={{ display: "grid", gap: 12, marginTop: 12, padding: 12, background: "#15181e", borderRadius: 6 }}>
             <Field label="Worker Command"><input value={workerCmd} onChange={e => setWorkerCmd(e.target.value)} /></Field>
             <Field label="Device">
                <select value={device} onChange={e => setDevice(e.target.value)}>
                  <option value="cpu">Processor (CPU)</option>
                  <option value="cuda">NVIDIA GPU (CUDA)</option>
                  <option value="mps">Apple GPU (MPS)</option>
                </select>
             </Field>
             <Field label="Working Directory"><input value={cwd} placeholder="(Default)" onChange={e => setCwd(e.target.value)} /></Field>
             <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
               <Field label="Concurrency"><input type="number" value={concurrency} onChange={e => setConcurrency(Number(e.target.value))} /></Field>
               <Field label="Timeout (s)"><input type="number" value={timeoutSecs} onChange={e => setTimeoutSecs(Number(e.target.value))} /></Field>
               <Field label="Max Attempts"><input type="number" value={maxAttempts} onChange={e => setMaxAttempts(Number(e.target.value))} /></Field>
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
