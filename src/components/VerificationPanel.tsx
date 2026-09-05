import { useCallback, useState } from "react";
import { runVerificationPlan } from "../api";
import type { VerificationPace, VerificationPlan, VerificationStrategy } from "../types";

const STRATEGIES: VerificationStrategy[] = ["random", "stratified", "uncertainty", "completeness"];

const STRATEGY_HINT: Record<VerificationStrategy, string> = {
  random: "uniform sample of the unreviewed pool",
  stratified: "proportional across confidence bands",
  uncertainty: "closest to the detection threshold first",
  completeness: "closest to the quality threshold first",
};

export interface VerificationPanelProps {
  dbPath: string;
  sessionId: number;
  /** Detection operating point (θ_A) the session ran at; the panel's starting threshold. */
  thetaA: number;
  /** Completeness operating point (θ_B), used by the completeness strategy. */
  thetaB: number;
  onSelectEvent: (id: number, path: string) => void;
  onLogAction: (action: string, meta?: Record<string, unknown>) => void;
}

function paceLabel(pace: VerificationPace): string {
  if (pace.source === "measured") {
    return `measured from ${pace.n_decisions ?? 0} recorded decisions`;
  }
  if (pace.source === "flag") return "supplied";
  return "assumed — no review telemetry recorded yet";
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.1em",
  color: "var(--text-faint)",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--line)",
  background: "var(--bg-deep)",
  color: "var(--text)",
  fontFamily: "var(--mono)",
  fontSize: 11.5,
};

const statLabelStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 10,
  letterSpacing: "0.1em",
  color: "var(--text-faint)",
};

const statValueStyle: React.CSSProperties = {
  fontFamily: "var(--mono)",
  fontSize: 15,
  color: "var(--text)",
  fontVariantNumeric: "tabular-nums",
};

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div>
      <div style={statLabelStyle}>{label}</div>
      <div style={statValueStyle}>{value}</div>
      {note && <div style={{ fontSize: 10.5, color: "var(--text-dim)", marginTop: 2 }}>{note}</div>}
    </div>
  );
}

export default function VerificationPanel({
  dbPath, sessionId, thetaA, thetaB, onSelectEvent, onLogAction,
}: VerificationPanelProps) {
  const [open, setOpen] = useState(false);
  const [threshold, setThreshold] = useState(String(thetaA));
  const [targetHalfWidth, setTargetHalfWidth] = useState("0.05");
  const [strategy, setStrategy] = useState<VerificationStrategy>("uncertainty");
  const [budget, setBudget] = useState("10");
  const [plan, setPlan] = useState<VerificationPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const compute = useCallback(async () => {
    const t = Number(threshold);
    const hw = Number(targetHalfWidth);
    const b = Math.max(0, Math.round(Number(budget)));
    if (!Number.isFinite(t) || !Number.isFinite(hw) || hw <= 0 || !Number.isFinite(b)) {
      setError("Threshold, target half-width (> 0) and budget must be numbers.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onLogAction("verification_plan", { threshold: t, targetHalfWidth: hw, strategy, budget: b });
    } catch {
      // Telemetry is best-effort and must never block the plan.
    }
    try {
      setPlan(await runVerificationPlan(dbPath, t, hw, strategy, b, thetaB, sessionId));
    } catch (e) {
      setPlan(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, [dbPath, sessionId, threshold, targetHalfWidth, strategy, budget, thetaB, onLogAction]);

  const pickEvent = useCallback((id: number, path: string) => {
    try {
      onLogAction("verification_queue_pick", { eventId: id, path, strategy });
    } catch {
      // Telemetry is best-effort and must never block selection.
    }
    onSelectEvent(id, path);
  }, [onSelectEvent, onLogAction, strategy]);

  const p = plan?.precision;
  const e = plan?.effort;
  const stop = plan?.stopping_rule.stop === true;

  return (
    <div style={{ border: "1px solid var(--line)", borderRadius: "var(--radius)", background: "var(--surface)", padding: "10px 13px" }}>
      <button className="disclosure" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="chev">{open ? "▼" : "▶"}</span> Verification plan
      </button>
      {open && (
        <div className="internals">
          <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 10 }}>
            How many more detections must be verified to pin precision to a target interval, and
            which ones to review next.
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: 10, alignItems: "end" }}>
            <div>
              <label style={labelStyle} htmlFor="vp-threshold">THRESHOLD θ_A</label>
              <input id="vp-threshold" type="number" step="0.01" style={inputStyle}
                value={threshold} onChange={(ev) => setThreshold(ev.target.value)} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="vp-halfwidth">TARGET ±</label>
              <input id="vp-halfwidth" type="number" step="0.01" min="0.001" style={inputStyle}
                value={targetHalfWidth} onChange={(ev) => setTargetHalfWidth(ev.target.value)} />
            </div>
            <div>
              <label style={labelStyle} htmlFor="vp-strategy">STRATEGY</label>
              <select id="vp-strategy" style={inputStyle} value={strategy}
                onChange={(ev) => setStrategy(ev.target.value as VerificationStrategy)}>
                {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label style={labelStyle} htmlFor="vp-budget">QUEUE SIZE</label>
              <input id="vp-budget" type="number" step="1" min="0" style={inputStyle}
                value={budget} onChange={(ev) => setBudget(ev.target.value)} />
            </div>
            <button onClick={() => void compute()} disabled={busy}
              style={{ ...inputStyle, width: "auto", cursor: busy ? "default" : "pointer",
                background: "var(--amber-soft)", borderColor: "var(--amber)", color: "var(--text)",
                letterSpacing: "0.06em" }}>
              {busy ? "computing…" : plan ? "recompute" : "compute plan"}
            </button>
          </div>
          <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 4 }}>
            {STRATEGY_HINT[strategy]}
          </div>

          {error && (
            <div style={{ marginTop: 12, padding: "8px 10px", borderRadius: "var(--radius-sm)",
              border: "1px solid var(--coral)", background: "var(--coral-soft)",
              color: "var(--text)", fontSize: 11.5, whiteSpace: "pre-wrap" }}>
              {error}
            </div>
          )}

          {plan && p && e && (
            <>
              <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
                <Stat label="ABOVE THRESHOLD" value={String(p.n_above_threshold)} />
                <Stat label="VERIFIED" value={String(p.n_verified)}
                  note={`${p.n_true} confirmed, ${p.n_verified - p.n_true} rejected`} />
                <Stat label="REMAINING" value={String(p.n_unreviewed)} />
              </div>

              <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <div style={statLabelStyle}>PRECISION AT θ_A {p.threshold.toFixed(3)}</div>
                {p.point === null ? (
                  <div style={{ marginTop: 4, fontSize: 12.5, color: "var(--text-dim)", fontStyle: "italic" }}>
                    No verified labels yet — precision is unknown, not zero. Verify some detections
                    to get an estimate.
                  </div>
                ) : (
                  <div style={{ marginTop: 4 }}>
                    <span style={{ ...statValueStyle, fontSize: 22 }}>{(p.point * 100).toFixed(1)}%</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 12, color: "var(--text-dim)", marginLeft: 8 }}>
                      [{(p.ci_low * 100).toFixed(1)}%, {(p.ci_high * 100).toFixed(1)}%] ±{(p.half_width * 100).toFixed(1)}pp
                      at {(p.confidence * 100).toFixed(0)}% (Wilson)
                    </span>
                  </div>
                )}
              </div>

              <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12,
                display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
                <Stat label={`MORE TO REACH ±${e.target_half_width}`} value={String(e.n_additional)}
                  note={`${e.n_required} total required${e.requires_census ? " — a full census of the pool" : ""}`} />
                <Stat label="ESTIMATED TIME"
                  value={`${e.estimated_minutes.toFixed(1)} min`}
                  note={`${e.seconds_per_verification.toFixed(1)} s/clip — ${paceLabel(plan.pace)}`} />
                {p.point === null && (
                  <Stat label="PLANNING ASSUMPTION" value={e.p_assumed.toFixed(2)}
                    note="conservative precision used while no data exists" />
                )}
              </div>

              <div style={{ marginTop: 14, padding: "8px 10px", borderRadius: "var(--radius-sm)",
                border: `1px solid ${stop ? "var(--jade)" : "var(--amber)"}`,
                background: stop ? "var(--jade-soft)" : "var(--amber-soft)" }}>
                <span style={{ fontFamily: "var(--mono)", fontSize: 11, fontWeight: 700, letterSpacing: "0.12em",
                  color: stop ? "var(--jade)" : "var(--amber)" }}>
                  {stop ? "STOP" : "CONTINUE"}
                </span>
                <div style={{ fontSize: 11.5, color: "var(--text-dim)", marginTop: 3 }}>
                  {plan.stopping_rule.reason}
                </div>
              </div>

              <div style={{ marginTop: 14, borderTop: "1px solid var(--line)", paddingTop: 12 }}>
                <div style={statLabelStyle}>NEXT {plan.queue.length} TO REVIEW</div>
                {plan.queue.length === 0 ? (
                  <div style={{ marginTop: 4, fontSize: 11.5, color: "var(--text-dim)", fontStyle: "italic" }}>
                    Queue empty — nothing unreviewed above this threshold.
                  </div>
                ) : (
                  <div style={{ marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
                    {plan.queue.map((q) => (
                      <button key={q.id} onClick={() => pickEvent(q.id, q.path)}
                        title={`conf ${q.stage_a_conf.toFixed(4)}` +
                          (q.completeness_score === null ? ", completeness n/a" : `, completeness ${q.completeness_score.toFixed(4)}`) +
                          `, file ${q.path}`}
                        style={{ fontFamily: "var(--mono)", fontSize: 11, padding: "3px 9px",
                          borderRadius: 999, border: "1px solid var(--line)", background: "var(--bg-deep)",
                          color: "var(--text-dim)", cursor: "pointer", fontVariantNumeric: "tabular-nums" }}>
                        #{q.id} · {q.stage_a_conf.toFixed(3)}
                      </button>
                    ))}
                  </div>
                )}
                <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 6 }}>
                  Selecting a queued event opens its recording and highlights the detection.
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
