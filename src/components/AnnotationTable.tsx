import React, { useState } from 'react';
import { Download, Trash2, Edit2, Check, X, Music } from 'lucide-react';
import type { Annotation } from '../lib/db';

interface AnnotationTableProps {
  annotations: Annotation[];
  onSelectAnnotation?: (ann: Annotation) => void;
  onDeleteAnnotation?: (id: number) => void;
  onEditAnnotation?: (ann: Annotation) => void;
}

export const AnnotationTable: React.FC<AnnotationTableProps> = ({
  annotations,
  onSelectAnnotation,
  onDeleteAnnotation,
  onEditAnnotation,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editPeakFreq, setEditPeakFreq] = useState<number>(0);
  const [editStart, setEditStart] = useState<number>(0);
  const [editEnd, setEditEnd] = useState<number>(0);

  const handleExport = () => {
    // Generate a simple Raven-like CSV format
    let csv = 'Selection,View,Channel,Begin Time (s),End Time (s),Low Freq (Hz),High Freq (Hz),Label\n';
    annotations.forEach((ann, idx) => {
      // Dummy low/high freq based on peak
      const low = Math.max(0, ann.peakFreq - 1000);
      const high = ann.peakFreq + 1000;
      csv += `${idx + 1},Spectrogram,1,${ann.start.toFixed(3)},${ann.end.toFixed(3)},${low.toFixed(1)},${high.toFixed(1)},"${ann.label.replace(/"/g, '""')}"\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bird_annotations_${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const startEditing = (ann: Annotation) => {
    if (ann.id === undefined) return;
    setEditingId(ann.id);
    setEditLabel(ann.label);
    setEditPeakFreq(ann.peakFreq);
    setEditStart(ann.start);
    setEditEnd(ann.end);
  };

  const saveEdit = (ann: Annotation) => {
    if (ann.id === undefined || !onEditAnnotation) return;
    onEditAnnotation({
      ...ann,
      label: editLabel.trim() || ann.label,
      peakFreq: Number(editPeakFreq) || ann.peakFreq,
      start: Number(editStart) >= 0 ? Number(editStart) : ann.start,
      end: Number(editEnd) > Number(editStart) ? Number(editEnd) : ann.end,
    });
    setEditingId(null);
  };

  const cancelEditing = () => {
    setEditingId(null);
  };

  if (annotations.length === 0) {
    return (
      <div style={{ backgroundColor: 'var(--bg-panel)', padding: '3rem 2rem', borderRadius: 8, textAlign: 'center', border: '1px solid var(--border-color)' }}>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.95rem' }}>No annotations yet. Use click-and-drag on the spectrogram, or click "Run Detector" above to identify vocalizations.</p>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--bg-panel)', padding: '1.25rem', borderRadius: 8, border: '1px solid var(--border-color)' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600, color: 'var(--text-primary)' }}>
          Acoustic Detections ({annotations.length})
        </h3>
        <button onClick={handleExport} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', padding: '0.5rem 1rem', fontSize: '0.85rem' }}>
          <Download size={15} /> Export Raven CSV
        </button>
      </div>
      
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-color)', color: 'var(--text-secondary)', fontWeight: 500 }}>
              <th style={{ padding: '0.75rem 0.5rem' }}>Label</th>
              <th style={{ padding: '0.75rem 0.5rem' }}>Start (s)</th>
              <th style={{ padding: '0.75rem 0.5rem' }}>End (s)</th>
              <th style={{ padding: '0.75rem 0.5rem' }}>Duration (s)</th>
              <th style={{ padding: '0.75rem 0.5rem' }}>Peak Freq (Hz)</th>
              <th style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {annotations.map((ann) => {
              const isEditing = editingId === ann.id;
              return (
                <tr 
                  key={ann.id} 
                  style={{ 
                    borderBottom: '1px solid var(--border-color)',
                    transition: 'background-color 0.2s',
                  }}
                  className="table-row-hover"
                >
                  <td style={{ padding: '0.75rem 0.5rem' }}>
                    {isEditing ? (
                      <input
                        type="text"
                        value={editLabel}
                        onChange={(e) => setEditLabel(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.3rem 0.5rem',
                          borderRadius: 4,
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-color)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    ) : (
                      <span style={{ fontWeight: 500 }}>{ann.label}</span>
                    )}
                  </td>
                  <td style={{ padding: '0.75rem 0.5rem' }}>
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        value={editStart}
                        onChange={(e) => setEditStart(Number(e.target.value))}
                        style={{
                          width: '70px',
                          padding: '0.3rem 0.5rem',
                          borderRadius: 4,
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-color)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    ) : (
                      ann.start.toFixed(2)
                    )}
                  </td>
                  <td style={{ padding: '0.75rem 0.5rem' }}>
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        value={editEnd}
                        onChange={(e) => setEditEnd(Number(e.target.value))}
                        style={{
                          width: '70px',
                          padding: '0.3rem 0.5rem',
                          borderRadius: 4,
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-color)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    ) : (
                      ann.end.toFixed(2)
                    )}
                  </td>
                  <td style={{ padding: '0.75rem 0.5rem', color: 'var(--text-secondary)' }}>
                    {(ann.end - ann.start).toFixed(2)}s
                  </td>
                  <td style={{ padding: '0.75rem 0.5rem' }}>
                    {isEditing ? (
                      <input
                        type="number"
                        step="10"
                        value={editPeakFreq}
                        onChange={(e) => setEditPeakFreq(Number(e.target.value))}
                        style={{
                          width: '80px',
                          padding: '0.3rem 0.5rem',
                          borderRadius: 4,
                          border: '1px solid var(--border-color)',
                          backgroundColor: 'var(--bg-color)',
                          color: 'var(--text-primary)',
                        }}
                      />
                    ) : (
                      <span style={{ 
                        backgroundColor: 'rgba(59, 130, 246, 0.15)', 
                        color: '#60a5fa', 
                        padding: '0.15rem 0.4rem', 
                        borderRadius: 4,
                        fontSize: '0.8rem',
                        fontWeight: 600
                      }}>
                        {ann.peakFreq.toFixed(0)} Hz
                      </span>
                    )}
                  </td>
                  <td style={{ padding: '0.75rem 0.5rem', textAlign: 'right' }}>
                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end' }}>
                      {isEditing ? (
                        <>
                          <button 
                            title="Save" 
                            onClick={() => saveEdit(ann)}
                            style={{ padding: '0.35rem', backgroundColor: '#10b981', color: '#fff', display: 'flex', alignItems: 'center' }}
                          >
                            <Check size={14} />
                          </button>
                          <button 
                            title="Cancel" 
                            onClick={cancelEditing}
                            style={{ padding: '0.35rem', display: 'flex', alignItems: 'center' }}
                          >
                            <X size={14} />
                          </button>
                        </>
                      ) : (
                        <>
                          {onSelectAnnotation && (
                            <button 
                              title="Listen / Select" 
                              onClick={() => onSelectAnnotation(ann)}
                              style={{ padding: '0.35rem', display: 'flex', alignItems: 'center', color: 'var(--accent-color)', border: '1px solid rgba(59, 130, 246, 0.3)' }}
                            >
                              <Music size={14} />
                            </button>
                          )}
                          <button 
                            title="Edit" 
                            onClick={() => startEditing(ann)}
                            style={{ padding: '0.35rem', display: 'flex', alignItems: 'center' }}
                          >
                            <Edit2 size={14} />
                          </button>
                          {onDeleteAnnotation && ann.id !== undefined && (
                            <button 
                              title="Delete" 
                              className="danger" 
                              onClick={() => onDeleteAnnotation(ann.id!)}
                              style={{ padding: '0.35rem', display: 'flex', alignItems: 'center' }}
                            >
                              <Trash2 size={14} />
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

