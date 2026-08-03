import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, Volume2, VolumeX, Plus } from 'lucide-react';
import type { EventRow } from '../types';

const FREQ_MIN = 0;
const FREQ_MAX = 11025;

function regionColorForStatus(status: EventRow['review_status'], selected: boolean): string {
  const alpha = selected ? 0.55 : 0.25;
  switch (status) {
    case 'confirmed': return `rgba(79,214,163,${alpha})`;
    case 'rejected':  return `rgba(240,106,78,${alpha})`;
    default:          return `rgba(244,162,58,${alpha})`;
  }
}
function borderColorForStatus(status: EventRow['review_status']): string {
  switch (status) {
    case 'confirmed': return '#4fd6a3';
    case 'rejected':  return '#f06a4e';
    default:          return '#f4a23a';
  }
}

interface AudioVisualizerProps {
  src: string | null;
  events: EventRow[];
  selectedId: number | null;
  onSelectEvent?: (id: number) => void;
  onUpdateBounds?: (id: number, t_start: number, t_end: number, f_low: number, f_high: number) => void;
  onAddEvent?: (e: { t_start: number; t_end: number; f_low: number; f_high: number }) => void;
  onDeleteEvent?: (id: number) => void;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  src, events, selectedId, onSelectEvent, onUpdateBounds, onAddEvent, onDeleteEvent,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const regionsPlugin = useRef<InstanceType<typeof RegionsPlugin> | null>(null);
  const suppressNewRegion = useRef(false);
  const regionToEventId = useRef<Map<string, number>>(new Map());

  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(50);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [wsReady, setWsReady] = useState(false);

  // 2D Spectrogram Bounding Box Drag State
  const [isDrawMode, setIsDrawMode] = useState(false);
  const isDrawModeRef = useRef(isDrawMode);
  useEffect(() => { isDrawModeRef.current = isDrawMode; }, [isDrawMode]);

  const [drawStart, setDrawStart] = useState<{ x: number; y: number; t: number; f: number } | null>(null);
  const [drawCurrent, setDrawCurrent] = useState<{ x: number; y: number; t: number; f: number } | null>(null);

  const eventsRef = useRef<EventRow[]>(events);
  useEffect(() => { eventsRef.current = events; }, [events]);
  const onSelectEventRef = useRef(onSelectEvent);
  const onUpdateBoundsRef = useRef(onUpdateBounds);
  const onAddEventRef = useRef(onAddEvent);
  useEffect(() => { onSelectEventRef.current = onSelectEvent; }, [onSelectEvent]);
  useEffect(() => { onUpdateBoundsRef.current = onUpdateBounds; }, [onUpdateBounds]);
  useEffect(() => { onAddEventRef.current = onAddEvent; }, [onAddEvent]);

  useEffect(() => {
    if (!src) return;
    setWsReady(false);
    if (!containerRef.current || !specRef.current || !timelineRef.current) return;
    if (wavesurfer.current) {
      wavesurfer.current.destroy();
      wavesurfer.current = null; regionsPlugin.current = null; regionToEventId.current.clear();
    }
    const wsRegions = RegionsPlugin.create();
    regionsPlugin.current = wsRegions;
    const wsTimeline = TimelinePlugin.create({
      container: timelineRef.current,
      style: { color: 'var(--text-dim)', fontSize: '10px' },
    });
    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#6f6253', progressColor: '#f4a23a', cursorColor: '#f06a4e',
      height: 90, minPxPerSec: zoom, autoCenter: true,
      plugins: [
        wsRegions, wsTimeline,
        Spectrogram.create({ container: specRef.current, labels: true, height: 180,
          splitChannels: false, frequencyMin: FREQ_MIN }),
      ],
    });
    wavesurfer.current = ws;
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('timeupdate', (time) => setCurrentTime(time));
    ws.on('ready', (dur) => { setDuration(dur); setCurrentTime(0); setWsReady(true); });

    wsRegions.enableDragSelection({ color: 'rgba(244,162,58,0.22)' });
    wsRegions.on('region-created', (region: any) => {
      if (suppressNewRegion.current || !isDrawModeRef.current) {
        region.remove();
        return;
      }
      const cur = eventsRef.current;
      let f_low = FREQ_MIN, f_high = FREQ_MAX;
      if (cur.length > 0) {
        const sorted = [...cur].sort((a, b) => a.center_freq - b.center_freq);
        const mid = sorted[Math.floor(sorted.length / 2)];
        f_low = mid.f_low; f_high = mid.f_high;
      }
      onAddEventRef.current?.({ t_start: region.start, t_end: region.end, f_low, f_high });
      region.remove();
    });
    wsRegions.on('region-updated', (region: any) => {
      const eventId = regionToEventId.current.get(region.id);
      if (eventId === undefined) return;
      const ev = eventsRef.current.find((e) => e.id === eventId);
      if (!ev) return;
      if (Math.abs(ev.t_start - region.start) > 0.005 || Math.abs(ev.t_end - region.end) > 0.005) {
        onUpdateBoundsRef.current?.(eventId, region.start, region.end, ev.f_low, ev.f_high);
      }
    });
    wsRegions.on('region-clicked', (region: any, e: MouseEvent) => {
      e.stopPropagation();
      const eventId = regionToEventId.current.get(region.id);
      if (eventId !== undefined) onSelectEventRef.current?.(eventId);
    });

    ws.load(src).catch((err) => {
      if (err.name !== 'AbortError') {
        console.error("WaveSurfer load error:", err);
      }
    });
    return () => {
      ws.destroy();
      wavesurfer.current = null; regionsPlugin.current = null; regionToEventId.current.clear();
      setWsReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  useEffect(() => {
    const wsRegions = regionsPlugin.current;
    if (!wsRegions || !wsReady) return;

    suppressNewRegion.current = true;

    // Get current regions in wavesurfer
    const currentRegions = wsRegions.getRegions();
    const newEventIds = new Set(events.map(ev => String(ev.id)));

    // 1. Remove regions that are no longer in events
    currentRegions.forEach(region => {
      if (!newEventIds.has(region.id)) {
        region.remove();
        regionToEventId.current.delete(region.id);
      }
    });

    // 2. Add or update regions
    events.forEach(ev => {
      const regionId = String(ev.id);
      const isSelected = ev.id === selectedId;
      const border = borderColorForStatus(ev.review_status);
      const color = regionColorForStatus(ev.review_status, isSelected);
      const style = {
        borderLeft: `2px solid ${border}`,
        borderRight: `2px solid ${border}`,
        transition: 'background-color .18s ease, box-shadow .18s ease',
        ...(isSelected
          ? { outline: `2px solid ${border}`, outlineOffset: '-1px', boxShadow: `0 0 16px -3px ${border}, inset 0 0 24px -10px ${border}` }
          : {}),
      };

      const existingRegion = currentRegions.find(r => r.id === regionId);
      if (!existingRegion) {
        // Create new region
        wsRegions.addRegion({
          id: regionId,
          start: ev.t_start,
          end: ev.t_end,
          color,
          drag: true,
          resize: true,
          content: ev.label ?? undefined,
          // @ts-ignore
          style,
        });
        regionToEventId.current.set(regionId, ev.id);
      } else {
        // Update existing region options
        const startDiff = Math.abs(existingRegion.start - ev.t_start) > 0.001;
        const endDiff = Math.abs(existingRegion.end - ev.t_end) > 0.001;
        
        // We compare basic options to minimize DOM reflow
        // @ts-ignore
        const colorDiff = existingRegion.color !== color;
        // @ts-ignore
        const contentDiff = existingRegion.content !== (ev.label ?? '');

        if (startDiff || endDiff || colorDiff || contentDiff) {
          existingRegion.setOptions({
            start: ev.t_start,
            end: ev.t_end,
            color,
            content: ev.label ?? undefined,
            // @ts-ignore
            style,
          });
        }
      }
    });

    suppressNewRegion.current = false;
  }, [events, selectedId, wsReady]);

  useEffect(() => {
    if (selectedId === null || !wavesurfer.current || !wsReady) return;
    const ev = events.find((e) => e.id === selectedId);
    if (ev) wavesurfer.current.setTime(ev.t_start);
  }, [selectedId, events, wsReady]);

  useEffect(() => { if (wavesurfer.current && wsReady) wavesurfer.current.zoom(zoom); }, [zoom, wsReady]);
  useEffect(() => { if (wavesurfer.current && wsReady) wavesurfer.current.setPlaybackRate(playbackRate); }, [playbackRate, wsReady]);
  useEffect(() => { if (wavesurfer.current && wsReady) wavesurfer.current.setMuted(isMuted); }, [isMuted, wsReady]);

  const togglePlay = () => wavesurfer.current?.playPause();
  const formatTime = (t: number) => {
    const m = Math.floor(t / 60); const s = (t % 60).toFixed(1);
    return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
  };

  // Helper to map Spectrogram Mouse Event to (Time, Frequency)
  const [panStart, setPanStart] = useState<{ x: number; scrollLeft: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const getCanvasCoordsFromClient = (clientX: number, clientY: number) => {
    const specContainer = specRef.current;
    if (!specContainer) return null;
    const canvas = specContainer.querySelector('canvas');
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    const scrollParent = canvas.parentElement;
    const sLeft = scrollParent ? scrollParent.scrollLeft : 0;
    
    const x = clientX - rect.left;
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    
    const totalX = x + sLeft;
    const t = Math.max(0, totalX / zoom);
    const fRatio = 1 - (y / rect.height);
    const f = Math.max(FREQ_MIN, Math.min(FREQ_MAX, FREQ_MIN + fRatio * (FREQ_MAX - FREQ_MIN)));
    return { x, y, t, f, rect };
  };

  const handleSpecMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return;
    const coords = getCanvasCoordsFromClient(e.clientX, e.clientY);
    if (!coords) return;

    if (isDrawMode) {
      setDrawStart(coords);
      setDrawCurrent(coords);
    } else if (wavesurfer.current) {
      const currentScroll = wavesurfer.current.getScroll();
      setPanStart({ x: e.clientX, scrollLeft: currentScroll });
    }
    setIsDragging(true);
  };

  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (!wavesurfer.current) return;
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const currentScroll = wavesurfer.current.getScroll();
    wavesurfer.current.setScroll(Math.max(0, currentScroll + delta));
  };

  useEffect(() => {
    if (!isDragging) return;

    const handleWindowMouseMove = (ev: MouseEvent) => {
      if (isDrawModeRef.current && drawStart) {
        const coords = getCanvasCoordsFromClient(ev.clientX, ev.clientY);
        if (coords) setDrawCurrent(coords);
      } else if (!isDrawModeRef.current && panStart && wavesurfer.current) {
        const dx = ev.clientX - panStart.x;
        const newScroll = Math.max(0, panStart.scrollLeft - dx);
        wavesurfer.current.setScroll(newScroll);
      }
    };

    const handleWindowMouseUp = () => {
      if (isDrawModeRef.current && drawStart && drawCurrent) {
        const tStart = Math.min(drawStart.t, drawCurrent.t);
        const tEnd = Math.max(drawStart.t, drawCurrent.t);
        const fLow = Math.min(drawStart.f, drawCurrent.f);
        const fHigh = Math.max(drawStart.f, drawCurrent.f);

        if (Math.abs(tEnd - tStart) > 0.05) {
          onAddEventRef.current?.({ t_start: tStart, t_end: tEnd, f_low: fLow, f_high: fHigh });
        }
      }
      setIsDragging(false);
      setDrawStart(null);
      setDrawCurrent(null);
      setPanStart(null);
    };

    window.addEventListener('mousemove', handleWindowMouseMove);
    window.addEventListener('mouseup', handleWindowMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove);
      window.removeEventListener('mouseup', handleWindowMouseUp);
    };
  }, [isDragging, drawStart, drawCurrent, panStart, zoom]);

  if (!src) {
    return (
      <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', border: '2px dashed var(--line)', borderRadius: 12,
        backgroundColor: 'var(--surface)', padding: '2rem' }}>
        <p style={{ color: 'var(--text-dim)', fontSize: '1rem', fontWeight: 500 }}>Select a file to review</p>
      </div>
    );
  }

  // Draw Box Preview Calculation
  let previewStyle: React.CSSProperties | null = null;
  if (drawStart && drawCurrent) {
    const x1 = Math.min(drawStart.x, drawCurrent.x);
    const x2 = Math.max(drawStart.x, drawCurrent.x);
    const y1 = Math.min(drawStart.y, drawCurrent.y);
    const y2 = Math.max(drawStart.y, drawCurrent.y);
    previewStyle = {
      position: 'absolute',
      left: x1,
      top: y1,
      width: Math.max(4, x2 - x1),
      height: Math.max(4, y2 - y1),
      border: '2px dashed var(--amber)',
      backgroundColor: 'rgba(244,162,58,0.25)',
      boxShadow: '0 0 12px rgba(244,162,58,0.5)',
      pointerEvents: 'none',
      zIndex: 20,
    };
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', backgroundColor: 'var(--surface)',
      padding: '1.1rem', borderRadius: 'var(--radius)', border: '1px solid var(--line)', boxShadow: 'var(--shadow)' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center',
        justifyContent: 'space-between', borderBottom: '1px solid var(--line)', paddingBottom: '0.75rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button onClick={togglePlay} className="primary" style={{ display: 'flex', alignItems: 'center',
            gap: '0.5rem', minWidth: 96, justifyContent: 'center' }}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}{isPlaying ? 'Pause' : 'Play'}
          </button>
          <button
            onClick={() => setIsDrawMode((v) => !v)}
            style={{
              display: 'flex', alignItems: 'center', gap: '0.4rem',
              background: isDrawMode ? 'var(--amber)' : 'var(--surface-2)',
              color: isDrawMode ? '#000' : 'var(--amber)',
              fontWeight: 600,
              fontSize: '0.78rem', borderRadius: 'var(--radius-sm)', padding: '0.4rem 0.75rem',
              cursor: 'pointer', border: '1px solid var(--amber)',
              boxShadow: isDrawMode ? '0 0 12px rgba(244,162,58,0.5)' : 'none',
              transition: 'all 0.15s ease'
            }}
            title="Toggle interactive 2D bounding box drawing directly on the spectrogram"
          >
            <Plus size={15} /> {isDrawMode ? 'Drawing Mode Active' : 'Draw Bounding Box'}
          </button>
          <span style={{ fontFamily: 'var(--mono)', fontSize: '0.82rem', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums', letterSpacing: '0.02em' }}>
            {formatTime(currentTime)} <span style={{ color: 'var(--text-faint)' }}>/</span> {formatTime(duration)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
            <button onClick={() => setZoom((z) => Math.max(10, z - 15))} title="Zoom out" style={{ padding: '0.35rem' }}><ZoomOut size={16} /></button>
            <span style={{ fontFamily: 'var(--mono)', fontSize: '0.72rem', minWidth: 54, textAlign: 'center', color: 'var(--text-dim)', fontVariantNumeric: 'tabular-nums' }}>{zoom} px/s</span>
            <button onClick={() => setZoom((z) => Math.min(500, z + 15))} title="Zoom in" style={{ padding: '0.35rem' }}><ZoomIn size={16} /></button>
          </div>
          <select value={playbackRate} onChange={(e) => setPlaybackRate(Number(e.target.value))}
            style={{ backgroundColor: 'var(--bg-deep)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.74rem',
              border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '0.35rem 0.5rem' }}>
            <option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="0.75">0.75x</option>
            <option value="1.0">1.0x</option><option value="1.5">1.5x</option><option value="2.0">2.0x</option>
          </select>
          <button onClick={() => setIsMuted((m) => !m)} title={isMuted ? 'Unmute' : 'Mute'} style={{ padding: '0.4rem 0.6rem' }}>
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, backgroundColor: 'var(--bg-deep)',
        padding: '0.5rem', borderRadius: 'var(--radius-sm)', border: '1px solid var(--line)', overflow: 'hidden' }}>
        <div
          style={{
            position: 'relative',
            width: '100%',
            overflow: 'hidden',
            cursor: isDrawMode ? 'crosshair' : (isDragging ? 'grabbing' : 'grab'),
            userSelect: 'none',
          }}
          onMouseDown={handleSpecMouseDown}
          onWheel={handleWheel}
        >
          {!wsReady && (
            <div style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              minHeight: 180,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 12,
              backgroundColor: 'rgba(15, 14, 18, 0.88)',
              backdropFilter: 'blur(6px)',
              zIndex: 50,
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--line)'
            }}>
              <div className="loading-spinner" style={{ width: 28, height: 28 }} />
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--amber)', letterSpacing: '0.08em', fontWeight: 600 }}>
                  GENERATING FFT SPECTROGRAM…
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '9.5px', color: 'var(--text-faint)' }}>
                  Decoding Audio Waveform Track
                </span>
              </div>
            </div>
          )}
          <div ref={specRef} style={{ width: '100%', overflow: 'hidden', backgroundColor: 'var(--bg-deep)' }} />
          {previewStyle && <div style={previewStyle} />}
          
          {/* Render 2D Bounding Box Overlay for Events directly on the Spectrogram */}
          {events.map((ev) => {
            const isSelected = ev.id === selectedId;
            const border = borderColorForStatus(ev.review_status);
            const color = regionColorForStatus(ev.review_status, isSelected);
            const canvasEl = specRef.current?.querySelector('canvas');
            const scrollParent = canvasEl?.parentElement;
            const curScroll = scrollParent ? scrollParent.scrollLeft : 0;
            
            const left = ev.t_start * zoom - curScroll;
            const width = (ev.t_end - ev.t_start) * zoom;
            const top = 180 * (1 - (ev.f_high / FREQ_MAX));
            const height = 180 * ((ev.f_high - ev.f_low) / FREQ_MAX);

            if (left + width < 0 || left > 2000) return null; // Outside viewport

            return (
              <div
                key={`spec-box-${ev.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEvent?.(ev.id);
                }}
                style={{
                  position: 'absolute',
                  left,
                  top,
                  width: Math.max(6, width),
                  height: Math.max(6, height),
                  border: `2px solid ${border}`,
                  backgroundColor: color,
                  boxShadow: isSelected ? `0 0 14px ${border}` : 'none',
                  borderRadius: 3,
                  cursor: 'pointer',
                  zIndex: isSelected ? 15 : 10,
                  transition: 'border-color 0.15s ease, background-color 0.15s ease',
                }}
                title={`Event ${ev.id}: ${(ev.t_end - ev.t_start).toFixed(2)}s | ${Math.round(ev.f_low)}Hz - ${Math.round(ev.f_high)}Hz`}
              >
                {isSelected && (
                  <div style={{
                    position: 'absolute',
                    top: -22,
                    left: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    background: border,
                    color: '#000',
                    fontWeight: 700,
                    fontSize: '9.5px',
                    fontFamily: 'var(--mono)',
                    padding: '2px 7px',
                    borderRadius: 4,
                    whiteSpace: 'nowrap',
                    boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
                    zIndex: 30,
                    pointerEvents: 'auto',
                  }}>
                    <span>#{ev.id} {ev.label || `${Math.round(ev.f_low)}–${Math.round(ev.f_high)}Hz`}</span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteEvent?.(ev.id);
                      }}
                      style={{
                        padding: 0,
                        margin: 0,
                        minWidth: 'unset',
                        minHeight: 'unset',
                        width: 15,
                        height: 15,
                        borderRadius: '50%',
                        background: 'rgba(0,0,0,0.25)',
                        color: '#000',
                        border: 'none',
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        cursor: 'pointer',
                        fontSize: '10px',
                        lineHeight: 1,
                        transition: 'all 0.15s ease',
                      }}
                      title="Delete this bounding box (Press Delete/Backspace to delete, Cmd+Z to undo)"
                      onMouseEnter={(e) => { e.currentTarget.style.background = '#000'; e.currentTarget.style.color = '#fff'; }}
                      onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(0,0,0,0.25)'; e.currentTarget.style.color = '#000'; }}
                    >
                      ✕
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div ref={containerRef} style={{ width: '100%', backgroundColor: 'var(--bg-deep)' }} />
        <div ref={timelineRef} style={{ width: '100%', marginTop: 4 }} />
      </div>
      <div style={{ display: 'flex', gap: '1.1rem', alignItems: 'center', flexWrap: 'wrap',
        fontSize: '0.74rem', color: 'var(--text-dim)' }}>
        {(["Unreviewed", "var(--amber)", "Confirmed", "var(--jade)", "Rejected", "var(--coral)"] as const)
          .reduce<[string, string][]>((acc, _, i, a) => (i % 2 === 0 ? [...acc, [a[i], a[i + 1]]] : acc), [])
          .map(([label, c]) => (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 11, height: 11, borderRadius: 3, background: c, boxShadow: `0 0 0 1px ${c} inset, 0 0 8px -2px ${c}` }} />
              {label}
            </span>
          ))}
        <span style={{ marginLeft: 'auto', color: 'var(--amber)', fontWeight: 500, fontStyle: 'italic' }}>
          ⚡ Click "+ Draw Bounding Box" or click & drag directly on the spectrogram image to draw 2D time/frequency bounding boxes.
        </span>
      </div>
    </div>
  );
};
