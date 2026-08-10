import React, { useState } from 'react';
import { Check, X, Edit2, Trash2, Music } from 'lucide-react';
import type { EventRow } from '../types';

interface EventTableProps {
  events: EventRow[];
  selectedId: number | null;
  onSelect?: (id: number) => void;
  onSetReview?: (id: number, status: 'confirmed' | 'rejected' | 'unreviewed') => void;
  onDelete?: (id: number) => void;
  onEditLabelNote?: (id: number, label: string, note: string) => void;
}

const STATUS: Record<EventRow['review_status'], { bg: string; text: string; label: string }> = {
  unreviewed: { bg: 'rgba(244,162,58,0.15)', text: '#f4a23a', label: 'Unreviewed' },
  confirmed:  { bg: 'rgba(79,214,163,0.15)', text: '#4fd6a3', label: 'Confirmed' },
  rejected:   { bg: 'rgba(240,106,78,0.15)', text: '#f06a4e', label: 'Rejected' },
};
const inputStyle: React.CSSProperties = {
  padding: '0.3rem 0.5rem', borderRadius: 4, border: '1px solid var(--line)',
  backgroundColor: 'var(--bg-deep)', color: 'var(--text)', fontSize: '0.85rem',
};

export const EventTable: React.FC<EventTableProps> = ({
  events, selectedId, onSelect, onSetReview, onDelete, onEditLabelNote,
}) => {
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editLabel, setEditLabel] = useState('');
  const [editNote, setEditNote] = useState('');

  const startEditing = (ev: EventRow) => { setEditingId(ev.id); setEditLabel(ev.label ?? ''); setEditNote(ev.note ?? ''); };
  const saveEdit = (id: number) => { onEditLabelNote?.(id, editLabel, editNote); setEditingId(null); };

  const confirmed = events.filter((e) => e.review_status === 'confirmed').length;
  const rejected = events.filter((e) => e.review_status === 'rejected').length;
  const unreviewed = events.filter((e) => e.review_status === 'unreviewed').length;

  if (events.length === 0) {
    return (
      <div style={{ backgroundColor: 'var(--surface)', padding: '3rem 2rem', borderRadius: 'var(--radius)',
        textAlign: 'center', border: '1px solid var(--line)', boxShadow: 'var(--shadow)' }}>
        <p style={{ color: 'var(--text-dim)', margin: 0 }}>No events for this file.</p>
      </div>
    );
  }

  return (
    <div style={{ backgroundColor: 'var(--surface)', padding: '1.1rem', borderRadius: 'var(--radius)',
      border: '1px solid var(--line)', overflow: 'auto', boxShadow: 'var(--shadow)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.6rem', marginBottom: '1.1rem' }}>
        <Music size={15} style={{ color: 'var(--amber)', alignSelf: 'center' }} />
        <h3 style={{ margin: 0, fontFamily: 'var(--serif)', fontSize: '1.18rem', fontWeight: 600, color: 'var(--text)', letterSpacing: '-0.01em' }}>Events</h3>
        <span style={{ color: 'var(--text-faint)', fontSize: '0.78rem', fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums' }}>
          {events.length} · <span style={{ color: 'var(--jade)' }}>{confirmed} confirmed</span> ·{' '}
          <span style={{ color: 'var(--coral)' }}>{rejected} rejected</span> ·{' '}
          <span style={{ color: 'var(--amber)' }}>{unreviewed} unreviewed</span>
        </span>
      </div>
      <table className="ba-evtable" style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.875rem' }}>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--line-2)', color: 'var(--text-faint)',
            textTransform: 'uppercase', letterSpacing: '0.07em', fontSize: '0.64rem', fontWeight: 700, fontFamily: 'var(--mono)' }}>
            <th style={{ padding: '0.45rem 0.5rem' }}>Time</th><th style={{ padding: '0.45rem 0.5rem' }}>Center</th>
            <th style={{ padding: '0.45rem 0.5rem' }}>Completeness</th><th style={{ padding: '0.45rem 0.5rem' }}>Conf</th>
            <th style={{ padding: '0.45rem 0.5rem' }}>Source</th><th style={{ padding: '0.45rem 0.5rem' }}>Status</th>
            <th style={{ padding: '0.45rem 0.5rem', textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {events.map((ev) => {
            const isEditing = editingId === ev.id;
            const isSelected = ev.id === selectedId;
            const sm = STATUS[ev.review_status];
            return (
              <tr key={ev.id} onClick={() => !isEditing && onSelect?.(ev.id)}
                style={{ borderBottom: '1px solid var(--line)',
                  backgroundColor: isSelected ? 'var(--surface-2)' : 'transparent',
                  cursor: onSelect && !isEditing ? 'pointer' : 'default' }}>
                <td style={{ padding: '0.6rem 0.5rem', whiteSpace: 'nowrap', fontFamily: 'var(--mono)', fontVariantNumeric: 'tabular-nums', borderLeft: isSelected ? '2px solid var(--amber)' : '2px solid transparent' }}>
                  <span style={{ color: 'var(--text)', fontSize: '0.82rem' }}>{ev.t_start.toFixed(2)}–{ev.t_end.toFixed(2)}s</span><br />
                  <span style={{ fontSize: '0.72rem', color: 'var(--text-faint)' }}>{ev.duration.toFixed(2)}s</span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem', fontFamily: 'var(--mono)', fontSize: '0.82rem', color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>{(ev.center_freq / 1000).toFixed(2)}<span style={{ color: 'var(--text-faint)' }}> kHz</span></td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  {ev.completeness_label ?? '—'}
                  {ev.completeness_score !== null && (
                    <span style={{ color: 'var(--text-faint)', marginLeft: '0.3rem', fontFamily: 'var(--mono)', fontSize: '0.76rem' }}>({ev.completeness_score.toFixed(2)})</span>
                  )}
                  {ev.source === 'manual' && ev.human_completeness && (
                    <div style={{ color: 'var(--text-faint)', marginTop: 3, fontFamily: 'var(--mono)', fontSize: '0.64rem' }}>
                      human: {ev.human_completeness}
                      {ev.completeness_source === 'stage_b_accepted' ? ' · Stage B accepted' :
                        ev.completeness_source === 'unresolved' && ev.completeness_score !== null ? ' · Stage B suggestion' : ''}
                    </div>
                  )}
                </td>
                <td style={{ padding: '0.6rem 0.5rem', fontFamily: 'var(--mono)', fontSize: '0.82rem', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{ev.stage_a_conf.toFixed(2)}</td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  <span style={{ color: ev.source === 'ml' ? 'var(--violet)' : 'var(--text-faint)', fontFamily: 'var(--mono)', fontSize: '0.68rem', fontWeight: 700, letterSpacing: '0.04em' }}>
                    {ev.source === 'ml' ? 'ML' : 'Manual'}
                  </span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem' }}>
                  <span style={{ backgroundColor: sm.bg, color: sm.text, padding: '0.18rem 0.6rem', borderRadius: 999, fontSize: '0.7rem', fontWeight: 700, letterSpacing: '0.02em', boxShadow: `0 0 0 1px ${sm.text}33 inset` }}>{sm.label}</span>
                </td>
                <td style={{ padding: '0.6rem 0.5rem', textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                  {isEditing ? (
                    <div style={{ display: 'flex', gap: '0.4rem', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                      <input value={editLabel} onChange={(e) => setEditLabel(e.target.value)} placeholder="label" style={{ ...inputStyle, width: 84 }} />
                      <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="note" style={{ ...inputStyle, width: 110 }} />
                      <button title="Save" onClick={() => saveEdit(ev.id)} style={{ padding: '0.35rem', backgroundColor: 'var(--jade)', color: 'var(--bg-deep)', border: 'none', borderRadius: 'var(--radius-sm)' }}><Check size={14} /></button>
                      <button title="Cancel" onClick={() => setEditingId(null)} style={{ padding: '0.35rem', border: '1px solid var(--line)', borderRadius: 4, background: 'transparent', color: 'var(--text-dim)' }}><X size={14} /></button>
                    </div>
                  ) : (
                    <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                      {onSetReview && (
                        <button title="Confirm" onClick={() => onSetReview(ev.id, ev.review_status === 'confirmed' ? 'unreviewed' : 'confirmed')}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--line)',
                            background: ev.review_status === 'confirmed' ? 'rgba(79,214,163,0.18)' : 'transparent',
                            color: ev.review_status === 'confirmed' ? '#4fd6a3' : 'var(--text-dim)' }}><Check size={14} /></button>
                      )}
                      {onSetReview && (
                        <button title="Reject" onClick={() => onSetReview(ev.id, ev.review_status === 'rejected' ? 'unreviewed' : 'rejected')}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--line)',
                            background: ev.review_status === 'rejected' ? 'rgba(240,106,78,0.18)' : 'transparent',
                            color: ev.review_status === 'rejected' ? '#f06a4e' : 'var(--text-dim)' }}><X size={14} /></button>
                      )}
                      {onEditLabelNote && (
                        <button title="Edit label / note" onClick={() => startEditing(ev)}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid var(--line)', background: 'transparent', color: 'var(--text-dim)' }}><Edit2 size={14} /></button>
                      )}
                      {onDelete && (
                        <button title="Delete" onClick={() => onDelete(ev.id)}
                          style={{ padding: '0.35rem', borderRadius: 4, border: '1px solid rgba(240,106,78,0.3)', background: 'transparent', color: '#f06a4e' }}><Trash2 size={14} /></button>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
};
