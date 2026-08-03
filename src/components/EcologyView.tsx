import React, { useEffect, useState } from 'react';
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

interface EcologicalSummary {
  session_id: number;
  total_files: number;
  total_effort_hours: number;
  total_retained_events: number;
  bands: BandSummary[];
}

interface EcologyViewProps {
  sessionId: number | null;
  dbPath: string | null;
}

export const EcologyView: React.FC<EcologyViewProps> = ({ sessionId, dbPath }) => {
  const [summary, setSummary] = useState<EcologicalSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!sessionId || !dbPath) return;
    setLoading(true);
    invoke<EcologicalSummary>('get_ecological_summary', { sessionId, dbPath })
      .then((data) => {
        setSummary(data);
        setError(null);
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [sessionId, dbPath]);

  if (!sessionId || !dbPath) {
    return <div className="card">Please run a batch session to view ecological insights.</div>;
  }

  if (loading) return <div className="card">Calculating effort-normalized ecological metrics...</div>;
  if (error) return <div className="card error">Error loading ecology stats: {error}</div>;
  if (!summary) return null;

  return (
    <div className="view-container">
      <div className="card">
        <h2>Ecological Summary & Elevational Analysis</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', margin: '16px 0' }}>
          <div className="stat-box">
            <span className="stat-label">Total AudioMoth Files</span>
            <span className="stat-value">{summary.total_files}</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Survey Effort Hours</span>
            <span className="stat-value">{summary.total_effort_hours.toFixed(2)} h</span>
          </div>
          <div className="stat-box">
            <span className="stat-label">Retained Buzz Events</span>
            <span className="stat-value">{summary.total_retained_events}</span>
          </div>
        </div>

        <h3 style={{ marginTop: '24px' }}>Calling Rate (Buzzes / Hour) by Elevation Band</h3>
        <div style={{ display: 'flex', gap: '24px', margin: '16px 0', alignItems: 'flex-end', height: '180px', padding: '16px', background: 'var(--surface-dark)', borderRadius: '8px' }}>
          {summary.bands.map((b) => (
            <div key={b.band} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%' }}>
              <div style={{ marginTop: 'auto', width: '60px', height: `${Math.min(120, b.rate_per_hour * 10)}px`, background: 'var(--spectrogram)', borderRadius: '4px' }} />
              <span style={{ marginTop: '8px', fontWeight: 'bold' }}>{b.band}</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)' }}>{b.rate_per_hour.toFixed(2)} / h</span>
            </div>
          ))}
        </div>

        <h3 style={{ marginTop: '24px' }}>Elevation Band Metrics</h3>
        <table className="file-table" style={{ width: '100%', marginTop: '8px' }}>
          <thead>
            <tr>
              <th>Elevation Band</th>
              <th>Files</th>
              <th>Effort (h)</th>
              <th>Retained Events</th>
              <th>Rate (events/h)</th>
              <th>Mean Duration (s)</th>
              <th>Median Duration (s)</th>
            </tr>
          </thead>
          <tbody>
            {summary.bands.map((b) => (
              <tr key={b.band}>
                <td><strong>{b.band}</strong></td>
                <td>{b.file_count}</td>
                <td>{b.effort_hours.toFixed(2)}</td>
                <td>{b.retained_count}</td>
                <td>{b.rate_per_hour.toFixed(2)}</td>
                <td>{b.mean_duration_sec.toFixed(3)}</td>
                <td>{b.median_duration_sec.toFixed(3)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
