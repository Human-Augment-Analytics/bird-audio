import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, Volume2, VolumeX } from 'lucide-react';
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
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  src, events, selectedId, onSelectEvent, onUpdateBounds, onAddEvent,
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
          splitChannels: false, frequencyMin: FREQ_MIN, frequencyMax: FREQ_MAX }),
      ],
    });
    wavesurfer.current = ws;
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('timeupdate', (time) => setCurrentTime(time));
    ws.on('ready', (dur) => { setDuration(dur); setCurrentTime(0); setWsReady(true); });

    wsRegions.enableDragSelection({ color: 'rgba(244,162,58,0.22)' });
    wsRegions.on('region-created', (region: any) => {
      if (suppressNewRegion.current) return;
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

    ws.load(src);
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
    wsRegions.clearRegions();
    regionToEventId.current.clear();
    events.forEach((ev) => {
      const regionId = String(ev.id);
      const isSelected = ev.id === selectedId;
      const border = borderColorForStatus(ev.review_status);
      wsRegions.addRegion({
        id: regionId, start: ev.t_start, end: ev.t_end,
        color: regionColorForStatus(ev.review_status, isSelected),
        drag: true, resize: true, content: ev.label ?? undefined,
        // @ts-ignore — region style supported in wavesurfer v7
        style: {
          borderLeft: `2px solid ${border}`, borderRight: `2px solid ${border}`,
          transition: 'background-color .18s ease, box-shadow .18s ease',
          ...(isSelected
            ? { outline: `2px solid ${border}`, outlineOffset: '-1px', boxShadow: `0 0 16px -3px ${border}, inset 0 0 24px -10px ${border}` }
            : {}),
        },
      });
      regionToEventId.current.set(regionId, ev.id);
    });
    suppressNewRegion.current = false;
  }, [events, selectedId, wsReady]);

  // The effects below call wavesurfer methods that require decoded audio
  // (zoom/setTime throw "No audio loaded" if invoked before the 'ready' event).
  // Gate them all on wsReady; each re-applies its value once the track is ready.
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

  if (!src) {
    return (
      <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', border: '2px dashed var(--line)', borderRadius: 12,
        backgroundColor: 'var(--surface)', padding: '2rem' }}>
        <p style={{ color: 'var(--text-dim)', fontSize: '1rem', fontWeight: 500 }}>Select a file to review</p>
      </div>
    );
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
        <div ref={specRef} style={{ width: '100%', overflow: 'hidden', backgroundColor: 'var(--bg-deep)' }} />
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
        <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontStyle: 'italic' }}>Drag the spectrogram to mark a new event · drag region edges to adjust.</span>
      </div>
    </div>
  );
};
