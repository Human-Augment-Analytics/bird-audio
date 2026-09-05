import { useCallback, useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import RegionsPlugin, { type Region } from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, Volume2, VolumeX, Plus } from 'lucide-react';
import type { EventRow } from '../types';

const FREQ_MIN = 0;
const DEFAULT_FREQ_MAX = 11625;
const INITIAL_ZOOM = 50;

function spectrogramScrollElement(container: HTMLElement | null): HTMLElement | null {
  if (!container) return null;
  return container.firstElementChild instanceof HTMLElement ? container.firstElementChild : null;
}

function syncSpectrogramScroll(container: HTMLElement | null, scrollLeft: number) {
  const wrapper = spectrogramScrollElement(container);
  if (wrapper) wrapper.scrollLeft = scrollLeft;
}

function applyRegionStyle(region: Region, border: string, selected: boolean) {
  if (!region.element) return;
  Object.assign(region.element.style, {
    borderLeft: `2px solid ${border}`,
    borderRight: `2px solid ${border}`,
    transition: 'background-color .18s ease, box-shadow .18s ease',
    outline: selected ? `2px solid ${border}` : '',
    outlineOffset: selected ? '-1px' : '',
    boxShadow: selected ? `0 0 16px -3px ${border}, inset 0 0 24px -10px ${border}` : '',
  });
}

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
  frequencyMax?: number | null;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  src, events, selectedId, onSelectEvent, onUpdateBounds, onAddEvent, onDeleteEvent,
  frequencyMax,
}) => {
  const maxFrequency = frequencyMax && Number.isFinite(frequencyMax) && frequencyMax > 0
    ? frequencyMax
    : DEFAULT_FREQ_MAX;
  const containerRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const regionsPlugin = useRef<InstanceType<typeof RegionsPlugin> | null>(null);
  const suppressNewRegion = useRef(false);
  const regionToEventId = useRef<Map<string, number>>(new Map());

  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(INITIAL_ZOOM);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const playbackKey = src ? `${src}\u0000${maxFrequency}` : null;
  const [readyKey, setReadyKey] = useState<string | null>(null);
  // The spectrogram plugin computes its FFT after the audio is decoded; on a 15-minute
  // recording that takes several seconds, during which the panel would otherwise sit blank.
  const [spectrogramReadyKey, setSpectrogramReadyKey] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const wsReady = readyKey === playbackKey;
  const spectrogramReady = spectrogramReadyKey === playbackKey;
  const readyInstance = useRef<WaveSurfer | null>(null);
  const instanceReady = wsReady;
  const lastCenteredSelection = useRef<string | null>(null);

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

  const [scrollLeft, setScrollLeft] = useState(0);
  const [spectrogramWidth, setSpectrogramWidth] = useState(1200);
  const contentWidth = Math.max(spectrogramWidth, duration * zoom);
  const pixelsPerSecond = duration > 0 ? contentWidth / duration : zoom;

  useEffect(() => {
    const container = specRef.current;
    if (!container) return;
    const updateWidth = () => setSpectrogramWidth(container.clientWidth || 1200);
    const observer = new ResizeObserver(updateWidth);
    observer.observe(container);
    return () => observer.disconnect();
  }, [src]);

  useEffect(() => {
    if (!src) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setIsPlaying(false);
      setCurrentTime(0);
      setDuration(0);
      setScrollLeft(0);
      setLoadError(null);
      setReadyKey(null);
      setSpectrogramReadyKey(null);
    });
    const waveformContainer = containerRef.current;
    const spectrogramContainer = specRef.current;
    const timelineContainer = timelineRef.current;
    if (!waveformContainer || !spectrogramContainer || !timelineContainer) return;
    if (wavesurfer.current) {
      wavesurfer.current.destroy();
      wavesurfer.current = null; regionsPlugin.current = null; regionToEventId.current.clear();
    }
    readyInstance.current = null;
    spectrogramContainer.innerHTML = '';
    waveformContainer.innerHTML = '';
    timelineContainer.innerHTML = '';

    const wsRegions = RegionsPlugin.create();
    const eventIdMap = regionToEventId.current;
    regionsPlugin.current = wsRegions;
    const wsTimeline = TimelinePlugin.create({
      container: timelineContainer,
      style: { color: 'var(--text-dim)', fontSize: '10px' },
    });
    // Linear scale: the bounding-box overlay maps Hz to pixels linearly, and the plugin's
    // default mel scale left the 5-11 kHz buzz band blank on AudioMoth recordings.
    const wsSpectrogram = Spectrogram.create({ container: spectrogramContainer, labels: true, height: 180,
      splitChannels: false, frequencyMin: FREQ_MIN, frequencyMax: maxFrequency, scale: 'linear' });
    wsSpectrogram.on('ready', () => {
      if (active) setSpectrogramReadyKey(playbackKey);
    });
    const ws = WaveSurfer.create({
      container: waveformContainer,
      waveColor: '#6f6253', progressColor: '#f4a23a', cursorColor: '#f06a4e',
      height: 90, minPxPerSec: INITIAL_ZOOM, autoCenter: true,
      // wavesurfer decodes at 8 kHz by default (Nyquist 4 kHz); anything above that
      // would be painted as a flat block. Decode at 2x the displayed ceiling so the
      // spectrogram actually covers 0..maxFrequency.
      sampleRate: Math.ceil(maxFrequency * 2),
      plugins: [wsRegions, wsTimeline, wsSpectrogram],
    });
    wavesurfer.current = ws;
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('timeupdate', (time) => setCurrentTime(time));
    ws.on('scroll', (_visibleStart, _visibleEnd, px) => setScrollLeft(px));
    ws.on('ready', (dur) => {
      if (!active) return;
      setDuration(dur);
      setCurrentTime(0);
      setScrollLeft(ws.getScroll());
      readyInstance.current = ws;
      setReadyKey(playbackKey);
    });

    wsRegions.enableDragSelection({ color: 'rgba(244,162,58,0.22)' });
    wsRegions.on('region-created', (region) => {
      if (suppressNewRegion.current) return;
      if (!isDrawModeRef.current) {
        region.remove();
        return;
      }
      const cur = eventsRef.current;
      let f_low = FREQ_MIN, f_high = maxFrequency;
      if (cur.length > 0) {
        const sorted = [...cur].sort((a, b) => a.center_freq - b.center_freq);
        const mid = sorted[Math.floor(sorted.length / 2)];
        f_low = mid.f_low; f_high = mid.f_high;
      }
      onAddEventRef.current?.({ t_start: region.start, t_end: region.end, f_low, f_high });
      region.remove();
    });
    wsRegions.on('region-updated', (region) => {
      const eventId = regionToEventId.current.get(region.id);
      if (eventId === undefined) return;
      const ev = eventsRef.current.find((e) => e.id === eventId);
      if (!ev) return;
      if (Math.abs(ev.t_start - region.start) > 0.005 || Math.abs(ev.t_end - region.end) > 0.005) {
        onUpdateBoundsRef.current?.(eventId, region.start, region.end, ev.f_low, ev.f_high);
      }
    });
    wsRegions.on('region-clicked', (region, e) => {
      e.stopPropagation();
      const eventId = regionToEventId.current.get(region.id);
      if (eventId !== undefined) onSelectEventRef.current?.(eventId);
    });

    ws.load(src).catch((err: unknown) => {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        console.error("WaveSurfer load error:", err);
        if (active) setLoadError(String(err));
      }
    });
    return () => {
      active = false;
      ws.destroy();
      if (readyInstance.current === ws) readyInstance.current = null;
      spectrogramContainer.innerHTML = '';
      waveformContainer.innerHTML = '';
      timelineContainer.innerHTML = '';
      wavesurfer.current = null; regionsPlugin.current = null; eventIdMap.clear();
    };
  }, [src, maxFrequency, playbackKey]);

  useEffect(() => {
    const wsRegions = regionsPlugin.current;
    if (!wsRegions || !instanceReady || readyInstance.current !== wavesurfer.current) return;

    suppressNewRegion.current = true;
    try {
      const currentRegions = wsRegions.getRegions();
      const newEventIds = new Set(events.map(ev => String(ev.id)));

      currentRegions.forEach(region => {
        if (!newEventIds.has(region.id)) {
          region.remove();
          regionToEventId.current.delete(region.id);
        }
      });

      events.forEach(ev => {
        const regionId = String(ev.id);
        const isSelected = ev.id === selectedId;
        const border = borderColorForStatus(ev.review_status);
        const color = regionColorForStatus(ev.review_status, isSelected);
        const existingRegion = currentRegions.find(r => r.id === regionId);
        if (!existingRegion) {
          const region = wsRegions.addRegion({
            id: regionId,
            start: ev.t_start,
            end: ev.t_end,
            color,
            drag: true,
            resize: true,
            content: ev.label ?? undefined,
          });
          regionToEventId.current.set(regionId, ev.id);
          applyRegionStyle(region, border, isSelected);
        } else {
          const startDiff = Math.abs(existingRegion.start - ev.t_start) > 0.001;
          const endDiff = Math.abs(existingRegion.end - ev.t_end) > 0.001;
          const colorDiff = existingRegion.color !== color;
          const contentDiff = existingRegion.getContent() !== (ev.label ?? undefined);

          if (startDiff || endDiff || colorDiff || contentDiff) {
            existingRegion.setOptions({
              start: ev.t_start,
              end: ev.t_end,
              color,
            });
            if (contentDiff) existingRegion.setContent(ev.label ?? undefined);
          }
          applyRegionStyle(existingRegion, border, isSelected);
        }
      });
    } finally {
      suppressNewRegion.current = false;
    }
  }, [events, selectedId, instanceReady]);

  useEffect(() => { if (wavesurfer.current && instanceReady) wavesurfer.current.zoom(zoom); }, [zoom, instanceReady]);

  useEffect(() => {
    const selectionKey = playbackKey && selectedId !== null ? `${playbackKey}\u0000${selectedId}` : null;
    if (selectionKey === null) {
      lastCenteredSelection.current = null;
      return;
    }
    if (!wavesurfer.current || !instanceReady || readyInstance.current !== wavesurfer.current || lastCenteredSelection.current === selectionKey) return;
    const ev = events.find((e) => e.id === selectedId);
    if (ev) {
      lastCenteredSelection.current = selectionKey;
      wavesurfer.current.setTime(ev.t_start);
      const specContainer = specRef.current;
      const containerWidth = specContainer ? specContainer.clientWidth : 800;
      const targetScroll = Math.max(0, ev.t_start * pixelsPerSecond - containerWidth / 3);
      wavesurfer.current.setScroll(targetScroll);
      const actualScroll = wavesurfer.current.getScroll();
      setScrollLeft(actualScroll);
      syncSpectrogramScroll(specContainer, actualScroll);
    }
  }, [playbackKey, selectedId, events, instanceReady, pixelsPerSecond]);

  useEffect(() => {
    syncSpectrogramScroll(specRef.current, scrollLeft);
  }, [scrollLeft]);

  useEffect(() => { if (wavesurfer.current && instanceReady) wavesurfer.current.setPlaybackRate(playbackRate); }, [playbackRate, instanceReady]);
  useEffect(() => { if (wavesurfer.current && instanceReady) wavesurfer.current.setMuted(isMuted); }, [isMuted, instanceReady]);

  const togglePlay = () => wavesurfer.current?.playPause();
  const formatTime = (t: number) => {
    const m = Math.floor(t / 60); const s = (t % 60).toFixed(1);
    return `${m.toString().padStart(2, '0')}:${s.padStart(4, '0')}`;
  };

  // Helper to map Spectrogram Mouse Event to (Time, Frequency)
  const [panStart, setPanStart] = useState<{ x: number; scrollLeft: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const getCanvasCoordsFromClient = useCallback((clientX: number, clientY: number) => {
    const specContainer = specRef.current;
    if (!specContainer) return null;
    const rect = specContainer.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, clientY - rect.top));
    const totalX = x + (wavesurfer.current?.getScroll() ?? 0);
    const t = Math.max(0, Math.min(duration, totalX / pixelsPerSecond));
    const fRatio = 1 - (y / rect.height);
    const f = Math.max(FREQ_MIN, Math.min(maxFrequency, FREQ_MIN + fRatio * (maxFrequency - FREQ_MIN)));
    return { x, y, t, f, rect };
  }, [duration, maxFrequency, pixelsPerSecond]);

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
    e.preventDefault();
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

    const handleWindowMouseUp = (ev: MouseEvent) => {
      const end = getCanvasCoordsFromClient(ev.clientX, ev.clientY) ?? drawCurrent;
      if (isDrawModeRef.current && drawStart && end) {
        const tStart = Math.min(drawStart.t, end.t);
        const tEnd = Math.max(drawStart.t, end.t);
        const fLow = Math.min(drawStart.f, end.f);
        const fHigh = Math.max(drawStart.f, end.f);

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
  }, [isDragging, drawStart, drawCurrent, panStart, getCanvasCoordsFromClient]);

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
          <select defaultValue="1" onChange={(e) => setPlaybackRate(Number(e.target.value))}
            style={{ backgroundColor: 'var(--bg-deep)', color: 'var(--text)', fontFamily: 'var(--mono)', fontSize: '0.74rem',
              border: '1px solid var(--line)', borderRadius: 'var(--radius-sm)', padding: '0.35rem 0.5rem' }}>
            <option value="0.25">0.25x</option><option value="0.5">0.5x</option><option value="0.75">0.75x</option>
            <option value="1">1.0x</option><option value="1.5">1.5x</option><option value="2">2.0x</option>
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
            // The spectrogram container is empty until the plugin paints, so reserve its
            // height while loading; otherwise the absolute overlay has nothing to cover.
            minHeight: instanceReady && spectrogramReady ? undefined : 180,
            overflow: 'hidden',
            cursor: isDrawMode ? 'crosshair' : (isDragging ? 'grabbing' : 'grab'),
            userSelect: 'none',
          }}
          onMouseDown={handleSpecMouseDown}
          onWheel={handleWheel}
        >
          {(!instanceReady || !spectrogramReady) && (
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
              {!loadError && <div className="loading-spinner" style={{ width: 28, height: 28 }} />}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 }}>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--amber)', letterSpacing: '0.08em', fontWeight: 600 }}>
                  {loadError ? 'AUDIO LOAD FAILED' : instanceReady ? 'GENERATING FFT SPECTROGRAM…' : 'DECODING AUDIO…'}
                </span>
                <span style={{ fontFamily: 'var(--mono)', fontSize: '9.5px', color: 'var(--text-faint)' }}>
                  {loadError || (instanceReady ? 'Computing the frequency image for this recording' : 'Reading the waveform from disk')}
                </span>
              </div>
            </div>
          )}
          <div ref={specRef} style={{ width: '100%', overflow: 'hidden', backgroundColor: 'var(--bg-deep)' }} />
          {previewStyle && <div style={previewStyle} />}

          {/* Render 2D Bounding Box Overlay for Events directly on the Spectrogram */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              pointerEvents: 'none',
              transform: `translateX(-${scrollLeft}px)`,
              willChange: 'transform',
              // The transform makes this a stacking context; without an explicit
              // z-index the spectrogram canvases (z-index 4) paint over the boxes.
              zIndex: 12,
            }}
          >
            {events.map((ev) => {
              const isSelected = ev.id === selectedId;
              const border = borderColorForStatus(ev.review_status);
              const color = regionColorForStatus(ev.review_status, isSelected);

              const fLow = Number.isFinite(ev.f_low) && ev.f_low >= 0
                ? ev.f_low
                : (ev.center_freq ? Math.max(0, ev.center_freq - 1500) : 500);
              const fHigh = (ev.f_high && ev.f_high > fLow) ? ev.f_high : (ev.center_freq ? Math.min(maxFrequency, ev.center_freq + 1500) : maxFrequency);

              const left = ev.t_start * pixelsPerSecond;
              const width = Math.max(10, (ev.t_end - ev.t_start) * pixelsPerSecond);
              const top = 180 * (1 - (Math.min(maxFrequency, fHigh) / maxFrequency));
              const height = Math.max(12, 180 * ((Math.min(maxFrequency, fHigh) - Math.max(0, fLow)) / maxFrequency));

              const viewLeft = scrollLeft - 150;
              const viewRight = scrollLeft + spectrogramWidth + 150;
              if (left + width < viewLeft || left > viewRight) return null; // Outside viewport

              return (
                <div
                  key={`spec-box-${ev.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectEvent?.(ev.id);
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    left,
                    top,
                    width: Math.max(6, width),
                    height: Math.max(6, height),
                    border: `2px solid ${border}`,
                    backgroundColor: color,
                    boxShadow: isSelected ? `0 0 16px ${border}` : 'none',
                    borderRadius: 3,
                    cursor: 'pointer',
                    pointerEvents: 'auto',
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
        <span style={{ fontFamily: 'var(--mono)', color: 'var(--text-faint)' }}>
          display 0–{(maxFrequency / 1000).toFixed(3)} kHz
        </span>
      </div>
    </div>
  );
};
