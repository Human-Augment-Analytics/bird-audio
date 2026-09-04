import React, { useEffect, useId, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface BandSummary {
  band: string;
  file_count: number;
  effort_hours: number;
  event_count: number;
  retained_count: number;
  rate_per_hour: number;
  mean_duration_sec: number;
  median_duration_sec: number;
}

interface CountBin {
  label: string;
  start: number;
  end: number;
  event_count: number;
  retained_count: number;
}

interface DistributionStats {
  mean: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  min: number | null;
  max: number | null;
}

interface AnalysisContext {
  target: string;
  device: string;
  theta_a: number;
  theta_b: number;
  f_min_hz: number | null;
  f_max_hz: number | null;
  config_key: string | null;
}

interface RecorderSummary {
  recorder_id: string;
  elevation_band: string;
  file_count: number;
  effort_hours: number;
  event_count: number;
  retained_count: number;
  rate_per_hour: number;
  reviewed_count: number;
  review_coverage: number;
  mean_duration_sec: number | null;
  median_duration_sec: number | null;
  median_center_frequency_hz: number | null;
}

interface AnalyticsSummary {
  session_id: number;
  session_status: string;
  total_files: number;
  cached_files: number;
  inventory_verified: boolean;
  missing_cached_files: number;
  analyzed_files: number;
  failed_files: number;
  pending_files: number;
  in_progress_files: number;
  partial_results: boolean;
  total_effort_hours: number;
  effort_files_measured: number;
  effort_files_defaulted: number;
  total_events: number;
  total_retained_events: number;
  retention_rate: number;
  reviewed_events: number;
  confirmed_events: number;
  rejected_events: number;
  review_coverage: number;
  manual_events: number;
  stage_c_labeled_events: number;
  completeness_unscored_events: number;
  completeness_unscored_retained_events: number;
  incomplete_numeric_events: number;
  context: AnalysisContext;
  duration: DistributionStats;
  center_frequency_hz: DistributionStats;
  activity_bins: CountBin[];
  duration_bins: CountBin[];
  frequency_bins: CountBin[];
  confidence_bins: CountBin[];
  completeness_bins: CountBin[];
  recorders: RecorderSummary[];
  bands: BandSummary[];
}

interface EcologyViewProps {
  sessionId: number | null;
  dbPath: string | null;
  sessionStatus: string | null;
  /** Number of files finished so far; bumps the request key so analytics refresh while a session is active. */
  completedFiles: number;
}

type Scope = 'all' | 'retained';
type RecorderSort = 'retained_count' | 'rate_per_hour' | 'review_coverage' | 'median_duration_sec';

const formatNumber = (value: number | null, digits = 2) =>
  value === null || !Number.isFinite(value) ? '—' : value.toFixed(digits);

const formatPercent = (value: number) => `${Math.round(value * 100)}%`;

function MetricCard({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="analytics-kpi">
      <span className="stat-label">{label}</span>
      <span className="analytics-kpi__value">{value}</span>
      <span className="analytics-kpi__note">{note}</span>
    </div>
  );
}

function Histogram({
  title,
  subtitle,
  bins,
  scope,
  labelEvery = 2,
  unit,
}: {
  title: string;
  subtitle: string;
  bins: CountBin[];
  scope: Scope;
  labelEvery?: number;
  unit: string;
}) {
  const descriptionId = useId();
  const countFor = (bin: CountBin) =>
    scope === 'retained' ? bin.retained_count : bin.event_count;
  const scopeDetail = scope === 'retained'
    ? 'pipeline-retained events'
    : 'pipeline detections';
  const dataMax = Math.max(0, ...bins.map(countFor));
  const scaleMax = Math.max(1, dataMax);
  const total = bins.reduce((sum, bin) => sum + countFor(bin), 0);

  return (
    <section className="analytics-panel">
      <div className="analytics-panel__head">
        <div>
          <h3>{title}</h3>
          <p>{subtitle}</p>
        </div>
        <span className="analytics-panel__total mono">n={total.toLocaleString()}</span>
      </div>
      <div
        className={`analytics-histogram analytics-histogram--${scope}`}
        role="group"
        tabIndex={0}
        aria-label={`${title}. Maximum bin count ${dataMax}. Total ${total}.`}
        aria-describedby={descriptionId}
      >
        {total === 0 ? (
          <div className="analytics-histogram-empty">No observations in this scope</div>
        ) : (
          bins.map((bin, index) => {
            const count = countFor(bin);
            const height = count === 0 ? 0 : Math.max(4, (count / scaleMax) * 100);
            const range = `${bin.start.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}–${bin.end.toLocaleString(undefined, {
              maximumFractionDigits: 2,
            })}`;
            return (
              <div
                className="analytics-histogram__column"
                key={`${bin.start}-${bin.end}`}
                title={`${range} ${unit}: ${count.toLocaleString()} ${scopeDetail}`}
              >
                <div className="analytics-histogram__track">
                  <div className="analytics-histogram__bar" style={{ height: `${height}%` }} />
                </div>
                <span>
                  {index % labelEvery === 0 || index === bins.length - 1 ? bin.label : ''}
                </span>
              </div>
            );
          })
        )}
      </div>
      <ol className="sr-only" id={descriptionId}>
        {bins
          .filter((bin) => countFor(bin) > 0)
          .map((bin) => (
            <li key={`${bin.start}-${bin.end}-accessible`}>
              {bin.start.toLocaleString(undefined, { maximumFractionDigits: 2 })} to{' '}
              {bin.end.toLocaleString(undefined, { maximumFractionDigits: 2 })} {unit}:{' '}
              {countFor(bin).toLocaleString()} {scopeDetail}
            </li>
          ))}
      </ol>
      <div className="analytics-axis-note">
        <span>0</span>
        <span>{dataMax === 0 ? 'no observations' : `peak bin ${dataMax.toLocaleString()}`}</span>
      </div>
    </section>
  );
}

function ReviewComposition({ summary }: { summary: AnalyticsSummary }) {
  const unreviewed = Math.max(0, summary.total_events - summary.reviewed_events);
  const denominator = Math.max(1, summary.total_events);
  return (
    <section className="analytics-panel">
      <div className="analytics-panel__head">
        <div>
          <h3>Review status</h3>
          <p>Current curation states for pipeline detections</p>
        </div>
        <span className="analytics-panel__total mono">{formatPercent(summary.review_coverage)}</span>
      </div>
      <div
        className="analytics-review-bar"
        role="img"
        aria-label={`${summary.confirmed_events} confirmed, ${summary.rejected_events} rejected, ${unreviewed} unreviewed`}
      >
        <div
          className="analytics-review-bar__confirmed"
          style={{ width: `${summary.confirmed_events / denominator * 100}%` }}
        />
        <div
          className="analytics-review-bar__rejected"
          style={{ width: `${summary.rejected_events / denominator * 100}%` }}
        />
        <div
          className="analytics-review-bar__unreviewed"
          style={{ width: `${unreviewed / denominator * 100}%` }}
        />
      </div>
      <div className="analytics-legend">
        <span>
          <i className="legend-swatch legend-swatch--confirmed" />Confirmed{' '}
          <b>{summary.confirmed_events.toLocaleString()}</b>
        </span>
        <span>
          <i className="legend-swatch legend-swatch--rejected" />Rejected{' '}
          <b>{summary.rejected_events.toLocaleString()}</b>
        </span>
        <span>
          <i className="legend-swatch legend-swatch--unreviewed" />Unreviewed{' '}
          <b>{unreviewed.toLocaleString()}</b>
        </span>
      </div>
      <p className="analytics-footnote">
        {summary.manual_events.toLocaleString()} manual annotations (reported separately) ·{' '}
        {summary.stage_c_labeled_events.toLocaleString()} detections with Stage C labels
      </p>
    </section>
  );
}

function BandComparison({ bands }: { bands: BandSummary[] }) {
  const populated = bands.filter((band) => band.file_count > 0 || band.event_count > 0);
  const maxRate = Math.max(1, ...populated.map((band) => band.rate_per_hour));
  return (
    <section className="analytics-panel">
      <div className="analytics-panel__head">
        <div>
          <h3>Retained rate by elevation band</h3>
          <p>Retained detections per hour of recording effort</p>
        </div>
      </div>
      {populated.length === 0 ? (
        <div className="analytics-empty">No recorder bands could be inferred from the file paths.</div>
      ) : (
        <div className="analytics-ranking">
          {populated.map((band) => (
            <div className="analytics-ranking__row" key={band.band}>
              <span>{band.band}</span>
              <div className="analytics-ranking__track">
                <div
                  style={{
                    width: `${band.rate_per_hour / maxRate * 100}%`,
                    minWidth: band.rate_per_hour > 0 ? 2 : 0,
                  }}
                />
              </div>
              <strong className="mono">{band.rate_per_hour.toFixed(1)}/h</strong>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export const EcologyView: React.FC<EcologyViewProps> = ({
  sessionId,
  dbPath,
  sessionStatus,
  completedFiles,
}) => {
  const requestKey = sessionId && dbPath
    ? `${sessionId}:${dbPath}:${sessionStatus ?? 'active'}:${completedFiles}`
    : null;
  const [result, setResult] = useState<{
    key: string;
    summary: AnalyticsSummary | null;
    error: string | null;
  } | null>(null);
  const [scope, setScope] = useState<Scope>('retained');
  const [recorderSort, setRecorderSort] = useState<RecorderSort>('retained_count');

  useEffect(() => {
    if (!requestKey || !sessionId || !dbPath) return;
    let cancelled = false;
    invoke<AnalyticsSummary>('get_ecological_summary', { sessionId, dbPath })
      .then((data) => {
        if (!cancelled) setResult({ key: requestKey, summary: data, error: null });
      })
      .catch((err) => {
        if (!cancelled) setResult({ key: requestKey, summary: null, error: String(err) });
      });
    return () => { cancelled = true; };
  }, [requestKey, sessionId, dbPath]);

  const summary = result?.key === requestKey ? result.summary : null;
  const sortedRecorders = useMemo(() => {
    if (!summary) return [];
    return [...summary.recorders].sort((left, right) => {
      const leftValue = left[recorderSort] ?? -Infinity;
      const rightValue = right[recorderSort] ?? -Infinity;
      return rightValue - leftValue || left.recorder_id.localeCompare(right.recorder_id);
    });
  }, [summary, recorderSort]);

  if (!sessionId || !dbPath) {
    return <div className="card">Run a batch session to populate analytics.</div>;
  }
  if (result?.key !== requestKey) {
    return (
      <div className="card analytics-loading" role="status">
        <span className="loading-spinner" /> Building session analytics…
      </div>
    );
  }
  if (result.error) {
    return (
      <div className="card error" role="alert">
        {result.error.includes("0 completed files")
          ? "No audio files have finished processing yet. Run analysis will appear once at least one file completes."
          : `Error loading analytics: ${result.error}`}
      </div>
    );
  }
  if (!summary) return null;

  const scopedEvents = scope === 'retained'
    ? summary.total_retained_events
    : summary.total_events;
  const scopeName = scope === 'retained'
    ? 'Pipeline-retained events'
    : 'All pipeline detections';
  const unscoredCompleteness = scope === 'retained'
    ? summary.completeness_unscored_retained_events
    : summary.completeness_unscored_events;
  const frequencyBand = summary.context.f_min_hz === null && summary.context.f_max_hz === null
    ? 'Default frequency band'
    : summary.context.f_min_hz === null
      ? `Default minimum–${formatNumber(summary.context.f_max_hz, 0)} Hz`
      : summary.context.f_max_hz === null
        ? `${formatNumber(summary.context.f_min_hz, 0)} Hz–default maximum`
        : `${formatNumber(summary.context.f_min_hz, 0)}–${formatNumber(summary.context.f_max_hz, 0)} Hz`;

  return (
    <div className="view-container analytics-dashboard">
      <section className="card analytics-hero">
        <div>
          <div className="eyebrow">Session {summary.session_id} · {summary.session_status}</div>
          <h2>Session Analytics</h2>
          <p>Explore detection volume, curation quality, event shape, and recorder performance.</p>
          <div className="analytics-context" aria-label="Analysis settings">
            <span>{summary.context.target}</span>
            <span>{summary.context.device}</span>
            <span>Stage A ≥ {summary.context.theta_a.toFixed(2)}</span>
            <span>Stage B ≥ {summary.context.theta_b.toFixed(2)}</span>
            <span>{frequencyBand}</span>
            {summary.context.config_key && (
              <span title="The full analysis configuration is stored with this session.">
                Config recorded
              </span>
            )}
          </div>
        </div>
        <div className="analytics-scope" role="group" aria-label="Event scope">
          <button
            aria-pressed={scope === 'retained'}
            className={scope === 'retained' ? 'primary' : 'backlink'}
            onClick={() => setScope('retained')}
          >
            Retained
          </button>
          <button
            aria-pressed={scope === 'all'}
            className={scope === 'all' ? 'primary' : 'backlink'}
            onClick={() => setScope('all')}
          >
            All detections
          </button>
        </div>
      </section>

      {(
        !summary.inventory_verified
        || summary.partial_results
        || summary.effort_files_defaulted > 0
        || summary.incomplete_numeric_events > 0
      ) && (
        <section className="analytics-notices" aria-label="Analytics caveats">
          {!summary.inventory_verified && (
            <div className="analytics-callout analytics-callout--warning" role="alert">
              <strong>Legacy inventory:</strong> this session predates verified file-count
              {' '}tracking, so completeness cannot be confirmed. Rerun the input folder before
              {' '}relying on rates or comparisons.
            </div>
          )}
          {summary.partial_results && (
            <div className="analytics-callout analytics-callout--warning" role="alert">
              <strong>Partial session:</strong> metrics cover {summary.analyzed_files} of{' '}
              {summary.total_files} files. {summary.failed_files} failed,{' '}
              {summary.pending_files + summary.in_progress_files} unprocessed, and{' '}
              {summary.missing_cached_files} missing from cache. Rates and comparisons
              {' '}may not represent the full input set.
            </div>
          )}
          {summary.effort_files_defaulted > 0 && (
            <div className="analytics-callout">
              <strong>Estimated effort:</strong> {summary.effort_files_defaulted} files use
              {' '}the documented 0.25-hour estimate because an audio duration was unavailable.
            </div>
          )}
          {summary.incomplete_numeric_events > 0 && (
            <div className="analytics-callout">
              <strong>Incomplete legacy rows:</strong> {summary.incomplete_numeric_events}
              {' '}detections are omitted from affected charts and summary statistics;
              {' '}counts and rates still include them.
            </div>
          )}
        </section>
      )}

      <section className="analytics-kpi-grid">
        <MetricCard
          label="Files analyzed"
          value={`${summary.analyzed_files}/${summary.total_files}`}
          note={summary.failed_files ? `${summary.failed_files} failed files` : 'No file failures'}
        />
        <MetricCard
          label="Recording effort"
          value={`${summary.total_effort_hours.toFixed(2)} h`}
          note={`${summary.effort_files_measured} measured · ${summary.effort_files_defaulted} estimated`}
        />
        <MetricCard
          label={scopeName}
          value={scopedEvents.toLocaleString()}
          note={`${summary.total_events.toLocaleString()} total detections`}
        />
        <MetricCard
          label="Pipeline retention"
          value={formatPercent(summary.retention_rate)}
          note={`${summary.total_retained_events.toLocaleString()} passed the configured thresholds`}
        />
        <MetricCard
          label="Review coverage"
          value={formatPercent(summary.review_coverage)}
          note={`${summary.reviewed_events.toLocaleString()} detections currently reviewed`}
        />
        <MetricCard
          label="Typical retained event"
          value={`${formatNumber(summary.duration.median, 2)} s`}
          note={`${formatNumber(
            summary.center_frequency_hz.median === null
              ? null
              : summary.center_frequency_hz.median / 1000,
            2,
          )} kHz median center`}
        />
      </section>

      <section className="analytics-chart-grid analytics-chart-grid--wide">
        <Histogram
          title="Detections by recording offset"
          subtitle={`${scopeName}; raw pooled counts by seconds from each file’s start (not exposure-normalized)`}
          bins={summary.activity_bins}
          scope={scope}
          labelEvery={5}
          unit="seconds"
        />
      </section>

      <section className="analytics-chart-grid">
        <Histogram
          title="Stage A confidence"
          subtitle={`${scopeName}; confidence from 0 to 1`}
          bins={summary.confidence_bins}
          scope={scope}
          unit="confidence"
        />
        <Histogram
          title="Completeness score"
          subtitle={`${scopeName} with a Stage B score; ${unscoredCompleteness.toLocaleString()} without scores excluded`}
          bins={summary.completeness_bins}
          scope={scope}
          unit="completeness"
        />
        <Histogram
          title="Event duration"
          subtitle={`${scopeName}; the final bin includes the longest 1%`}
          bins={summary.duration_bins}
          scope={scope}
          unit="seconds"
        />
        <Histogram
          title="Center frequency"
          subtitle={`${scopeName}; chart range trims the outer 1% into edge bins`}
          bins={summary.frequency_bins}
          scope={scope}
          unit="Hz"
        />
      </section>

      <section className="analytics-chart-grid">
        <ReviewComposition summary={summary} />
        <BandComparison bands={summary.bands} />
      </section>

      <section className="card analytics-table-card">
        <div className="analytics-table-head">
          <div>
            <h3>Recorder performance</h3>
            <p>Rates use measured WAV, FLAC, and MP3 duration when available and the documented estimate otherwise.</p>
          </div>
          <label>
            Sort by
            <select
              value={recorderSort}
              onChange={(event) => setRecorderSort(event.target.value as RecorderSort)}
            >
              <option value="retained_count">Retained events</option>
              <option value="rate_per_hour">Rate per hour</option>
              <option value="review_coverage">Review coverage</option>
              <option value="median_duration_sec">Median duration</option>
            </select>
          </label>
        </div>
        <div className="analytics-table-wrap">
          <table className="site-table analytics-table">
            <caption className="sr-only">
              Recorder-level detection counts, recording effort, review coverage,
              and retained-event distributions
            </caption>
            <thead>
              <tr>
                <th>Recorder</th>
                <th>Band</th>
                <th className="text-right">Files</th>
                <th className="text-right">Effort</th>
                <th className="text-right">All</th>
                <th className="text-right">Retained</th>
                <th className="text-right">Rate/h</th>
                <th className="text-right">Review coverage</th>
                <th className="text-right">Median duration</th>
                <th className="text-right">Median frequency</th>
              </tr>
            </thead>
            <tbody>
              {sortedRecorders.map((recorder) => (
                <tr className="trow-site" key={recorder.recorder_id}>
                  <td className="font-semibold">{recorder.recorder_id}</td>
                  <td>{recorder.elevation_band}</td>
                  <td className="text-right mono">{recorder.file_count}</td>
                  <td className="text-right mono">{recorder.effort_hours.toFixed(2)} h</td>
                  <td className="text-right mono">{recorder.event_count.toLocaleString()}</td>
                  <td className="text-right mono">{recorder.retained_count.toLocaleString()}</td>
                  <td className="text-right mono">{recorder.rate_per_hour.toFixed(1)}</td>
                  <td className="text-right mono">{formatPercent(recorder.review_coverage)}</td>
                  <td className="text-right mono">
                    {formatNumber(recorder.median_duration_sec, 2)} s
                  </td>
                  <td className="text-right mono">
                    {formatNumber(
                      recorder.median_center_frequency_hz === null
                        ? null
                        : recorder.median_center_frequency_hz / 1000,
                      2,
                    )} kHz
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {sortedRecorders.length === 0 && (
          <div className="analytics-empty">No recorder rows are available.</div>
        )}
      </section>
    </div>
  );
};
