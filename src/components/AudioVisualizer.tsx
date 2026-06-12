import React, { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Spectrogram from 'wavesurfer.js/dist/plugins/spectrogram.esm.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';
import TimelinePlugin from 'wavesurfer.js/dist/plugins/timeline.esm.js';
import { Play, Pause, ZoomIn, ZoomOut, Volume2, VolumeX } from 'lucide-react';
import type { Annotation } from '../lib/db';

interface AudioVisualizerProps {
  blob: Blob | null;
  annotations: Annotation[];
  onAddAnnotation?: (ann: { start: number; end: number; label: string; peakFreq: number }) => void;
  onUpdateAnnotation?: (ann: Annotation) => void;
  selectedAnnotation: Annotation | null;
}

export const AudioVisualizer: React.FC<AudioVisualizerProps> = ({
  blob,
  annotations,
  onAddAnnotation,
  onUpdateAnnotation,
  selectedAnnotation,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const specRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const regionsPlugin = useRef<any>(null);
  
  const [isPlaying, setIsPlaying] = useState(false);
  const [zoom, setZoom] = useState(50);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isMuted, setIsMuted] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Initialize WaveSurfer and plugins
  useEffect(() => {
    if (!containerRef.current || !specRef.current || !timelineRef.current) return;

    const wsRegions = RegionsPlugin.create();
    regionsPlugin.current = wsRegions;

    const wsTimeline = TimelinePlugin.create({
      container: timelineRef.current,
      style: {
        color: 'var(--text-secondary)',
        fontSize: '10px',
      },
    });

    const ws = WaveSurfer.create({
      container: containerRef.current,
      waveColor: '#4b5563', // charcoal gray
      progressColor: '#3b82f6', // bright blue
      cursorColor: '#ef4444', // vibrant red cursor
      height: 90,
      minPxPerSec: zoom,
      autoCenter: true,
      plugins: [
        wsRegions,
        wsTimeline,
        Spectrogram.create({
          container: specRef.current,
          labels: true,
          height: 180,
          splitChannels: false,
          frequencyMin: 0,
          frequencyMax: 11025, // limit to audio spectrogram analysis
        }),
      ],
    });

    wavesurfer.current = ws;

    // Event listeners
    ws.on('play', () => setIsPlaying(true));
    ws.on('pause', () => setIsPlaying(false));
    ws.on('timeupdate', (time) => setCurrentTime(time));
    ws.on('ready', (dur) => {
      setDuration(dur);
      setCurrentTime(0);
    });

    // Enable drag selection for creating annotations
    wsRegions.enableDragSelection({
      color: 'rgba(59, 130, 246, 0.25)',
    });

    // Handle dragged region creation
    wsRegions.on('region-created', (region: any) => {
      // If it doesn't start with 'db-', it is user dragged (not from DB yet)
      if (!region.id.startsWith('db-')) {
        const label = prompt('Enter a label for this acoustic event:', 'Acoustic Event');
        if (label !== null) {
          const cleanLabel = label.trim() || 'Acoustic Event';
          if (onAddAnnotation) {
            onAddAnnotation({
              start: region.start,
              end: region.end,
              label: cleanLabel,
              peakFreq: 3000, // standard mid-band default
            });
          }
        }
        // Remove temporary visual region; it will be replaced by the DB-backed region
        region.remove();
      }
    });

    // Handle region update (drag/resize)
    wsRegions.on('region-updated', (region: any) => {
      if (region.id.startsWith('db-') && onUpdateAnnotation) {
        const dbId = Number(region.id.replace('db-', ''));
        const original = annotations.find((a) => a.id === dbId);
        if (original) {
          // Prevent infinite loops by checking threshold deviation
          const diffStart = Math.abs(original.start - region.start);
          const diffEnd = Math.abs(original.end - region.end);
          if (diffStart > 0.02 || diffEnd > 0.02) {
            onUpdateAnnotation({
              ...original,
              start: region.start,
              end: region.end,
            });
          }
        }
      }
    });

    return () => {
      ws.destroy();
    };
  }, []);

  // Sync annotations list to WaveSurfer regions
  useEffect(() => {
    const ws = wavesurfer.current;
    const wsRegions = regionsPlugin.current;
    if (!ws || !wsRegions) return;

    // Clear existing region elements
    wsRegions.clearRegions();

    // Redraw all annotations from state
    annotations.forEach((ann) => {
      if (ann.id === undefined) return;
      wsRegions.addRegion({
        id: `db-${ann.id}`,
        start: ann.start,
        end: ann.end,
        content: ann.label,
        color: 'rgba(59, 130, 246, 0.2)', // light blue overlay
        drag: true,
        resize: true,
        style: {
          borderLeft: '2px solid #3b82f6',
          borderRight: '2px solid #3b82f6',
        }
      });
    });
  }, [annotations]);

  // Sync loaded audio blob
  useEffect(() => {
    if (wavesurfer.current && blob) {
      const url = URL.createObjectURL(blob);
      wavesurfer.current.load(url);
      return () => URL.revokeObjectURL(url);
    }
  }, [blob]);

  // Handle Zoom change
  useEffect(() => {
    if (wavesurfer.current) {
      wavesurfer.current.zoom(zoom);
    }
  }, [zoom]);

  // Handle Playback rate change
  useEffect(() => {
    if (wavesurfer.current) {
      wavesurfer.current.setPlaybackRate(playbackRate);
    }
  }, [playbackRate]);

  // Handle Mute change
  useEffect(() => {
    if (wavesurfer.current) {
      wavesurfer.current.setMuted(isMuted);
    }
  }, [isMuted]);

  // Handle Selected Annotation selection (seeks and plays)
  useEffect(() => {
    let unsubscribe: (() => void) | null = null;

    if (wavesurfer.current && selectedAnnotation) {
      wavesurfer.current.setTime(selectedAnnotation.start);
      wavesurfer.current.play();

      // Automatically pause after the selection ends
      const checkPause = (time: number) => {
        if (time >= selectedAnnotation.end) {
          wavesurfer.current?.pause();
          if (unsubscribe) {
            unsubscribe();
            unsubscribe = null;
          }
        }
      };
      
      unsubscribe = wavesurfer.current.on('timeupdate', checkPause);
    }

    return () => {
      if (unsubscribe) unsubscribe();
    };
  }, [selectedAnnotation]);

  const togglePlay = () => {
    wavesurfer.current?.playPause();
  };

  const formatTime = (time: number) => {
    const mins = Math.floor(time / 60);
    const secs = (time % 60).toFixed(1);
    return `${mins.toString().padStart(2, '0')}:${secs.padStart(4, '0')}`;
  };

  if (!blob) {
    return (
      <div style={{ height: 320, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', border: '2px dashed var(--border-color)', borderRadius: 12, backgroundColor: 'var(--bg-panel)', padding: '2rem' }}>
        <p style={{ color: 'var(--text-secondary)', marginBottom: '0.5rem', fontSize: '1rem', fontWeight: 500 }}>No audio session loaded</p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', textAlign: 'center' }}>Record live microphone input or upload a local audio file to start analyzing spectrograms.</p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem', backgroundColor: 'var(--bg-panel)', padding: '1.25rem', borderRadius: 12, border: '1px solid var(--border-color)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.2)' }}>
      
      {/* Visualizer Controls */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '1rem', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border-color)', paddingBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
          <button onClick={togglePlay} className="primary" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', minWidth: '100px', justifyContent: 'center' }}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
            {isPlaying ? 'Pause' : 'Play'}
          </button>
          
          <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--text-secondary)', backgroundColor: 'var(--bg-color)', padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid var(--border-color)' }}>
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Zoom controls */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', backgroundColor: 'var(--bg-color)', padding: '0.2rem 0.4rem', borderRadius: 6, border: '1px solid var(--border-color)' }}>
            <button onClick={() => setZoom(z => Math.max(10, z - 15))} title="Zoom Out" style={{ padding: '0.35rem', background: 'transparent' }}>
              <ZoomOut size={16} />
            </button>
            <span style={{ fontSize: '0.8rem', minWidth: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>{zoom}px/s</span>
            <button onClick={() => setZoom(z => Math.min(500, z + 15))} title="Zoom In" style={{ padding: '0.35rem', background: 'transparent' }}>
              <ZoomIn size={16} />
            </button>
          </div>

          {/* Speed / Rate control */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <label style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Speed:</label>
            <select 
              value={playbackRate} 
              onChange={(e) => setPlaybackRate(Number(e.target.value))}
              style={{
                backgroundColor: 'var(--bg-color)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-color)',
                borderRadius: 6,
                padding: '0.35rem 0.5rem',
                fontSize: '0.85rem',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="0.25">0.25x (Slow)</option>
              <option value="0.5">0.50x</option>
              <option value="0.75">0.75x</option>
              <option value="1.0">1.00x (Normal)</option>
              <option value="1.5">1.50x</option>
              <option value="2.0">2.00x (Fast)</option>
            </select>
          </div>

          {/* Mute button */}
          <button onClick={() => setIsMuted(!isMuted)} title={isMuted ? 'Unmute' : 'Mute'} style={{ padding: '0.4rem 0.6rem' }}>
            {isMuted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>
      </div>
      
      {/* Waveform and Spectrogram Visual Display */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', backgroundColor: 'var(--bg-color)', padding: '0.5rem', borderRadius: 8, border: '1px solid var(--border-color)', overflow: 'hidden' }}>
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0.25rem 0.5rem', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', display: 'flex', justifyContent: 'space-between' }}>
          <span>Spectrogram (0 - 11 kHz)</span>
          <span>kHz</span>
        </div>
        <div ref={specRef} style={{ width: '100%', overflow: 'hidden', backgroundColor: '#0b0c10' }}></div>
        
        <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', padding: '0.25rem 0.5rem', borderBottom: '1px solid rgba(255, 255, 255, 0.05)', borderTop: '1px solid rgba(255, 255, 255, 0.05)', marginTop: '4px' }}>
          Waveform (Amplitude)
        </div>
        <div ref={containerRef} style={{ width: '100%', backgroundColor: '#0f172a' }}></div>
        
        <div ref={timelineRef} style={{ width: '100%', marginTop: '4px' }}></div>
      </div>
      
      <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', fontStyle: 'italic', textAlign: 'center' }}>
        Tip: Click and drag on the spectrogram to create a new manual selection. Drag or resize boundaries to modify.
      </div>
    </div>
  );
};

