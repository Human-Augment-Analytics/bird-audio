import { useCallback, useMemo, useState } from 'react';
import { pickFile, runResearchAnalysis } from '../api';
import type { ResearchAnalysis, ResearchModelTerm } from '../types';

interface Props {
  sessionId: number | null;
  dbPath: string | null;
  outputDir: string | null;
  thetaA: number;
  thetaB: number;
  sessionStatus: string | null;
}

const number = (value: number | null | undefined, digits = 2) =>
  value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const termLabel = (term: string) => term
  .replace('elevation_per_100m', 'Elevation (per 100 m)')
  .replace('date_sin', 'Date cycle (sine)')
  .replace('date_cos', 'Date cycle (cosine)')
  .replace(/^season_/, 'Season: ')
  .replace(/^site_/, 'Site: ')
  .replaceAll('_', ' ');

function ModelRow({ term }: { term: ResearchModelTerm }) {
  return (
    <tr>
      <td>{termLabel(term.term)}</td>
      <td className="text-right mono">{number(term.rate_ratio, 3)}</td>
      <td className="text-right mono">{number(term.ci_low, 3)}–{number(term.ci_high, 3)}</td>
      <td className="text-right mono">{number(term.p_value, 4)}</td>
    </tr>
  );
}

export function ResearchView({
  sessionId, dbPath, outputDir, thetaA, thetaB, sessionStatus,
}: Props) {
  const terminal = sessionStatus === 'done';
  const [metadataPath, setMetadataPath] = useState<string | null>(null);
  const [binMinutes, setBinMinutes] = useState(5);
  const [analysis, setAnalysis] = useState<ResearchAnalysis | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const run = useCallback(async () => {
    if (!sessionId || !dbPath || !outputDir || !terminal) return;
    setLoading(true);
    setError(null);
    try {
      setAnalysis(await runResearchAnalysis(
        dbPath, sessionId, outputDir, metadataPath, thetaA, thetaB, binMinutes,
      ));
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoading(false);
    }
  }, [sessionId, dbPath, outputDir, terminal, metadataPath, thetaA, thetaB, binMinutes]);

  const activityMax = useMemo(() => Math.max(
    1, ...(analysis?.activity.map((row) => row.ci_high ?? row.rate_per_hour ?? 0) ?? []),
  ), [analysis]);
  const sensitivityMinMax = useMemo(() => {
    const rates = analysis?.sensitivity.map((cell) => cell.rate_per_hour).filter((v): v is number => v != null) ?? [];
    return { min: Math.min(...rates, 0), max: Math.max(...rates, 1) };
  }, [analysis]);

  if (!sessionId || !dbPath || !outputDir) return <div className="card">Run a batch session to use research analysis.</div>;
  if (!terminal) return <div className="card"><strong>Formal research analysis blocked.</strong> Complete the full session first; failed or cancelled sessions can bias comparisons and exposure denominators.</div>;

  return (
    <div className="view-container research-dashboard">
      <section className="card analytics-hero research-hero">
        <div>
          <div className="eyebrow">Session {sessionId} · research workspace</div>
          <h2>Research Analysis</h2>
          <p>Build a traceable event set, normalize by measured exposure, quantify uncertainty, and test threshold robustness.</p>
          <div className="analytics-context">
            <span>Estimand: pipeline detections per audio hour</span>
            <span>Stage A ≥ {thetaA.toFixed(2)}</span>
            <span>Stage B ≥ {thetaB.toFixed(2)}</span>
            <span>95% intervals</span>
          </div>
        </div>
      </section>

      <section className="card research-controls">
        <div>
          <h3>Analysis inputs</h3>
          <p>Add a deployment CSV to control for site, elevation, season, and supplied weather. Required key: <span className="mono">device_id</span>. Optional: <span className="mono">site_id, elevation_m, season, temperature_c, precipitation_mm, wind_mps, humidity_pct</span>.</p>
        </div>
        <div className="research-controls__actions">
          <button className="backlink" onClick={async () => {
            const selected = await pickFile([{ name: 'Deployment metadata', extensions: ['csv'] }]);
            if (selected) { setMetadataPath(selected); setAnalysis(null); }
          }}>
            {metadataPath ? metadataPath.split('/').pop() : 'Choose metadata CSV'}
          </button>
          {metadataPath && <button className="backlink" onClick={() => { setMetadataPath(null); setAnalysis(null); }}>Clear</button>}
          <label>Activity bins
            <select value={binMinutes} onChange={(event) => { setBinMinutes(Number(event.target.value)); setAnalysis(null); }}>
              <option value={1}>1 minute</option><option value={5}>5 minutes</option>
              <option value={10}>10 minutes</option><option value={15}>15 minutes</option>
            </select>
          </label>
          <button className="primary" disabled={loading} onClick={() => void run()}>{loading ? 'Analyzing…' : 'Run analysis'}</button>
        </div>
      </section>

      {error && <div className="card error" role="alert">Research analysis failed: {error}</div>}
      {loading && !analysis && <div className="card analytics-loading" role="status"><span className="loading-spinner" /> Building research dataset and models…</div>}
      {!loading && !analysis && !error && <div className="card analytics-callout"><strong>Ready to build:</strong> review the inputs above, then run the analysis. Results are regenerated whenever the specification changes.</div>}

      {analysis && <>
        <section className="analytics-notices">
          {analysis.effort.defaulted_files != null && analysis.effort.defaulted_files > 0 && (
            <div className="analytics-callout analytics-callout--warning"><strong>Estimated exposure:</strong> {analysis.effort.defaulted_files} files still use 0.25 hours. Interpret rates conditionally and repair unreadable audio before publication.</div>
          )}
          {(analysis.activity[0]?.invalid_events_excluded ?? 0) > 0 && (
            <div className="analytics-callout analytics-callout--warning"><strong>Invalid event timing:</strong> {analysis.activity[0].invalid_events_excluded} events fell outside their own recording duration and were excluded from activity rates.</div>
          )}
          <div className="analytics-callout"><strong>Scientific scope:</strong> these are pipeline detection rates, not abundance, occupancy, or true call rates. Confidence intervals do not account for imperfect detection.</div>
        </section>

        <section className="analytics-kpi-grid">
          <div className="analytics-kpi"><span className="stat-label">Final curated events</span><span className="analytics-kpi__value">{analysis.curated_count.toLocaleString()}</span><span className="analytics-kpi__note">manual + accepted detector events</span></div>
          <div className="analytics-kpi"><span className="stat-label">Measured exposure</span><span className="analytics-kpi__value">{number(analysis.effort.total_hours)} h</span><span className="analytics-kpi__note">{analysis.effort.measured_files} measured · {analysis.effort.defaulted_files ?? 'unknown'} estimated</span></div>
          <div className="analytics-kpi"><span className="stat-label">Repeated-measure model</span><span className="analytics-kpi__value">{analysis.model.status.replace('_', ' ')}</span><span className="analytics-kpi__note">{analysis.model.n_recorders} recorders · {analysis.model.n_recordings} recordings</span></div>
        </section>

        <section className="card research-definition">
          <div><div className="eyebrow">Frozen dataset rule</div><h3>Final curated dataset</h3><p>{analysis.definition}.</p></div>
          <dl>
            <div><dt>Manual annotations</dt><dd>{analysis.curation_basis.manual_annotation ?? 0}</dd></div>
            <div><dt>Reviewer confirmed</dt><dd>{analysis.curation_basis.reviewer_confirmed ?? 0}</dd></div>
            <div><dt>Threshold retained, unreviewed</dt><dd>{analysis.curation_basis.threshold_retained_unreviewed ?? 0}</dd></div>
          </dl>
          <p className="analytics-callout"><strong>Inference rule:</strong> {analysis.inferential_event_set}.</p>
          <div className="research-paths"><span>Events: {analysis.outputs.curated_events_csv}</span><span>Recording rows: {analysis.outputs.model_ready_recordings_csv}</span><span>Analysis: {analysis.outputs.analysis_json}</span><span>Spec fingerprint: {analysis.outputs.research_spec_json} · {analysis.spec.spec_sha256.slice(0, 12)}</span></div>
        </section>

        <section className="analytics-panel research-activity">
          <div className="analytics-panel__head"><div><h3>Exposure-normalized activity by recording time</h3><p>Pipeline-curated events per exposed audio hour; whiskers are exact Poisson 95% confidence intervals.</p></div></div>
          <div className="research-interval-chart">
            {analysis.activity.map((row) => {
              const rate = row.rate_per_hour ?? 0;
              return <div className="research-interval-row" key={row.bin_start_minutes}>
                <span className="mono">{number(row.bin_start_minutes, 0)}–{number(row.bin_end_minutes, 0)}m</span>
                <div className="research-interval-track">
                  <div className="research-interval-ci" style={{ left: `${((row.ci_low ?? 0) / activityMax) * 100}%`, width: `${Math.max(1, (((row.ci_high ?? 0) - (row.ci_low ?? 0)) / activityMax) * 100)}%` }} />
                  <div className="research-interval-point" style={{ left: `${(rate / activityMax) * 100}%` }} />
                </div>
                <strong className="mono">{number(rate, 1)}/h</strong>
                <small className="mono">n={row.n_events}, {number(row.exposure_hours, 2)}h · {row.n_recorders_at_risk} known rec.</small>
              </div>;
            })}
          </div>
        </section>

        <section className="analytics-chart-grid">
          <section className="analytics-panel">
            <div className="analytics-panel__head"><div><h3>Adjusted rate model</h3><p>Log-effort offset; repeated recordings use recorder-clustered uncertainty.</p></div><span className="analytics-panel__total">{analysis.model.status.replace('_', ' ')}</span></div>
            {analysis.model.status === 'not_fitted' ? <div className="analytics-callout analytics-callout--warning"><strong>Model not fitted:</strong> {analysis.model.reason}</div> : <>
              {analysis.model.warning && <div className="analytics-callout analytics-callout--warning">{analysis.model.warning}</div>}
              <div className="analytics-table-wrap"><table className="site-table analytics-table"><thead><tr><th>Term</th><th className="text-right">Rate ratio</th><th className="text-right">95% CI</th><th className="text-right">p</th></tr></thead><tbody>{analysis.model.terms?.filter((term) => term.term !== 'intercept').map((term) => <ModelRow key={term.term} term={term} />)}</tbody></table></div>
              <p>Controls used: {analysis.model.controls_used?.join(', ') || 'none available'}. Unavailable: {analysis.model.controls_unavailable?.join(', ') || 'none'}.</p>
              {analysis.model.overdispersed && <div className="analytics-callout analytics-callout--warning">Counts are overdispersed (Pearson dispersion {number(analysis.model.dispersion, 2)}). Treat Poisson inference as provisional and compare a negative-binomial or GEE model before publication.</div>}
            </>}
          </section>

          <section className="analytics-panel">
            <div className="analytics-panel__head"><div><h3>Threshold sensitivity</h3><p>Two-dimensional Stage A × Stage B grid at and above the stored-candidate floor. Color shows pipeline detections per hour.</p></div><span className="analytics-panel__total">25 cells</span></div>
            <div className="research-heatmap" role="table" aria-label="Threshold sensitivity grid">
              {analysis.sensitivity.map((cell) => {
                const fraction = ((cell.rate_per_hour ?? 0) - sensitivityMinMax.min) / Math.max(0.0001, sensitivityMinMax.max - sensitivityMinMax.min);
                const title = cell.identifiable
                  ? `Stage A ${cell.theta_a.toFixed(2)}, Stage B ${cell.theta_b.toFixed(2)}: ${number(cell.rate_per_hour, 1)}/h; elevation RR ${number(cell.elevation_rate_ratio, 2)} (${cell.model_status})`
                  : `Stage A ${cell.theta_a.toFixed(2)} is below the stored-candidate floor; rerun inference.`;
                return <div key={`${cell.theta_a}-${cell.theta_b}`} className="research-heatmap__cell" style={{ background: cell.identifiable ? `rgba(244, 162, 58, ${0.1 + fraction * 0.7})` : 'var(--bg-deep)', opacity: cell.identifiable ? 1 : .55 }} title={title}><span>A {cell.theta_a.toFixed(2)}</span><span>B {cell.theta_b.toFixed(2)}</span><strong>{cell.identifiable ? `${number(cell.rate_per_hour, 1)}/h` : 'rerun'}</strong><span>RR {number(cell.elevation_rate_ratio, 2)}</span></div>;
              })}
            </div>
            <p className="analytics-callout">The session threshold remains primary. Cells below the model’s inference floor cannot recover detections that were never stored; they require rerunning inference.</p>
          </section>
        </section>
      </>}
    </div>
  );
}
