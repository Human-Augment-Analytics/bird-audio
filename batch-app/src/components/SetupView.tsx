import { useState, type ReactNode } from "react";
import { pickFolder, startSession } from "../api";
import type { StartOpts, StartResult } from "../types";

interface Props {
  onStarted: (result: StartResult, opts: StartOpts) => void;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      <span style={{ color: "#9aa0aa" }}>{label}</span>
      {children}
    </label>
  );
}

export default function SetupView({ onStarted }: Props) {
  const [input, setInput] = useState("");
  const [device, setDevice] = useState("cpu");
  const [concurrency, setConcurrency] = useState(0);
  const [workerCmd, setWorkerCmd] = useState("uv run python scripts/ml_engine.py --worker");
  const [cwd, setCwd] = useState("");
  const [thetaA, setThetaA] = useState(0);
  const [thetaB, setThetaB] = useState(0.530306);
  const [timeoutSecs, setTimeoutSecs] = useState(600);
  const [maxAttempts, setMaxAttempts] = useState(2);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const browse = async () => {
    const f = await pickFolder();
    if (f) setInput(f);
  };

  const start = async () => {
    if (!input) {
      setError("Choose an input folder first.");
      return;
    }
    setBusy(true);
    setError(null);
    const opts: StartOpts = {
      input,
      outputDir: input,
      device,
      concurrency,
      workerCmd: workerCmd,
      cwd: cwd.trim() === "" ? null : cwd,
      thetaA: thetaA,
      thetaB: thetaB,
      timeoutSecs: timeoutSecs,
      maxAttempts: maxAttempts,
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
    <div style={{ display: "grid", gap: 14, maxWidth: 760 }}>
      <h2>New batch session</h2>
      <Field label="Input folder">
        <div style={{ display: "flex", gap: 8 }}>
          <input
            style={{ flex: 1 }}
            value={input}
            placeholder="/path/to/recordings"
            onChange={(e) => setInput(e.target.value)}
          />
          <button onClick={browse}>Browse…</button>
        </div>
      </Field>
      <Field label="Worker command">
        <input value={workerCmd} onChange={(e) => setWorkerCmd(e.target.value)} />
      </Field>
      <Field label="Working dir for worker (cwd; usually the repo root)">
        <input
          value={cwd}
          placeholder="(blank = app's current dir)"
          onChange={(e) => setCwd(e.target.value)}
        />
      </Field>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
        <Field label="Device">
          <select value={device} onChange={(e) => setDevice(e.target.value)}>
            <option value="cpu">cpu</option>
            <option value="cuda">cuda</option>
            <option value="mps">mps</option>
          </select>
        </Field>
        <Field label="Concurrency (0 = auto)">
          <input
            type="number"
            min={0}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value))}
          />
        </Field>
        <Field label="θ_A">
          <input type="number" step="0.01" value={thetaA} onChange={(e) => setThetaA(Number(e.target.value))} />
        </Field>
        <Field label="θ_B">
          <input
            type="number"
            step="0.000001"
            value={thetaB}
            onChange={(e) => setThetaB(Number(e.target.value))}
          />
        </Field>
        <Field label="Timeout (s)">
          <input
            type="number"
            min={1}
            value={timeoutSecs}
            onChange={(e) => setTimeoutSecs(Number(e.target.value))}
          />
        </Field>
        <Field label="Max attempts">
          <input
            type="number"
            min={1}
            value={maxAttempts}
            onChange={(e) => setMaxAttempts(Number(e.target.value))}
          />
        </Field>
      </div>
      {error && <div style={{ color: "#f87171" }}>{error}</div>}
      <div>
        <button className="primary" disabled={busy} onClick={start}>
          {busy ? "Starting…" : "Start batch"}
        </button>
      </div>
    </div>
  );
}
