import { useState, useEffect, useRef } from 'react';
import { Mic, Square, Upload, Trash2, Calendar, FileAudio, Brain, Sliders, Cpu } from 'lucide-react';
import { db } from './lib/db';
import type { AudioSession, Annotation } from './lib/db';
import { AudioVisualizer } from './components/AudioVisualizer';
import { AnnotationTable } from './components/AnnotationTable';
import { detectVocalizations } from './lib/audioProcessor';
import { NativeProcessor } from './components/NativeProcessor';

function App() {
  // DB States
  const [sessions, setSessions] = useState<AudioSession[]>([]);
  const [activeSession, setActiveSession] = useState<AudioSession | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedAnnotation, setSelectedAnnotation] = useState<Annotation | null>(null);
  const [isTauri, setIsTauri] = useState(false);

  // Audio Detection Params
  const [sensitivity, setSensitivity] = useState<number>(3.0);
  const [minDuration, setMinDuration] = useState<number>(0.2);
  const [isScanning, setIsScanning] = useState<boolean>(false);

  // Recording States
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordingTime, setRecordingTime] = useState<number>(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  
  // Real-time Mic Visualizer Refs
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);

  // File Upload State
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load all sessions on mount
  useEffect(() => {
    setIsTauri(!!(window as any).__TAURI_INTERNALS__);
    loadSessions();
    return () => {
      stopRecordingTimer();
      stopMicVisualizer();
    };
  }, []);

  // Reload annotations when active session changes
  useEffect(() => {
    if (activeSession && activeSession.id !== undefined) {
      loadAnnotations(activeSession.id);
    } else {
      setAnnotations([]);
    }
    setSelectedAnnotation(null);
  }, [activeSession]);

  const loadSessions = async () => {
    try {
      const allSessions = await db.sessions.orderBy('createdAt').reverse().toArray();
      setSessions(allSessions);
      if (allSessions.length > 0 && !activeSession) {
        setActiveSession(allSessions[0]);
      }
    } catch (err) {
      console.error("Failed to load sessions from Dexie", err);
    }
  };

  const loadAnnotations = async (sessionId: number) => {
    try {
      const activeAnnotations = await db.annotations.where('sessionId').equals(sessionId).toArray();
      setAnnotations(activeAnnotations);
    } catch (err) {
      console.error("Failed to load annotations from Dexie", err);
    }
  };

  // --- Recording Logic ---
  const startRecording = async () => {
    audioChunksRef.current = [];
    setRecordingTime(0);
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/wav' });
        const name = `Recording_${new Date().toISOString().replace(/T/, '_').replace(/\..+/, '').replace(/:/g, '-')}`;
        
        // Save to Dexie
        const newSessionId = await db.sessions.add({
          name,
          blob: audioBlob,
          createdAt: new Date()
        });

        const newSession: AudioSession = {
          id: newSessionId,
          name,
          blob: audioBlob,
          createdAt: new Date()
        };

        setSessions(prev => [newSession, ...prev]);
        setActiveSession(newSession);
        
        // Release mic resources
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start(250); // Slice every 250ms
      setIsRecording(true);
      
      // Timer setup
      timerRef.current = window.setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      // Start live canvas visualizer
      startMicVisualizer(stream);

    } catch (err) {
      console.error("Microphone access denied or error", err);
      alert("Could not access microphone. Please verify site permissions.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      stopRecordingTimer();
      stopMicVisualizer();
    }
  };

  const stopRecordingTimer = () => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  };

  // Canvas visualizer for recording
  const startMicVisualizer = (stream: MediaStream) => {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    const audioCtx = new AudioContextClass();
    const analyser = audioCtx.createAnalyser();
    const source = audioCtx.createMediaStreamSource(stream);
    
    source.connect(analyser);
    analyser.fftSize = 256;
    
    audioContextRef.current = audioCtx;
    analyserRef.current = analyser;
    
    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    
    const draw = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      const width = canvas.width;
      const height = canvas.height;
      
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      
      ctx.fillStyle = '#1e1f22';
      ctx.fillRect(0, 0, width, height);
      
      const barWidth = (width / bufferLength) * 1.5;
      let x = 0;
      
      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * height * 0.8;
        
        // Greenish to blueish gradient
        const r = Math.floor(59 + (i * 2));
        const g = Math.floor(130 + (i * 0.5));
        const b = Math.floor(246 - (i * 2));
        
        ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
        ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
        x += barWidth;
      }
    };
    
    draw();
  };

  const stopMicVisualizer = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    analyserRef.current = null;
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
      micStreamRef.current = null;
    }
  };

  // --- File Upload Logic ---
  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    const file = files[0];
    const name = file.name;
    const blob = new Blob([file], { type: file.type });
    
    try {
      const newSessionId = await db.sessions.add({
        name,
        blob,
        createdAt: new Date()
      });

      const newSession: AudioSession = {
        id: newSessionId,
        name,
        blob,
        createdAt: new Date()
      };

      setSessions(prev => [newSession, ...prev]);
      setActiveSession(newSession);
      
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      console.error("Failed to save uploaded file", err);
      alert("Error saving file database.");
    }
  };

  // --- Session Removal ---
  const handleDeleteSession = async (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm("Are you sure you want to delete this audio session and all its detections?")) return;

    try {
      await db.sessions.delete(id);
      await db.annotations.where('sessionId').equals(id).delete();
      
      const updated = sessions.filter(s => s.id !== id);
      setSessions(updated);
      
      if (activeSession?.id === id) {
        setActiveSession(updated.length > 0 ? updated[0] : null);
      }
    } catch (err) {
      console.error("Failed to delete session", err);
    }
  };

  // --- Annotations Event Handlers ---
  const handleAddAnnotation = async (newAnn: { start: number; end: number; label: string; peakFreq: number }) => {
    if (!activeSession || activeSession.id === undefined) return;
    
    try {
      const newId = await db.annotations.add({
        sessionId: activeSession.id,
        label: newAnn.label,
        start: newAnn.start,
        end: newAnn.end,
        peakFreq: newAnn.peakFreq
      });
      
      const fullAnn: Annotation = {
        id: newId,
        sessionId: activeSession.id,
        ...newAnn
      };
      
      setAnnotations(prev => [...prev, fullAnn].sort((a, b) => a.start - b.start));
    } catch (err) {
      console.error("Failed to add annotation", err);
    }
  };

  const handleUpdateAnnotation = async (updatedAnn: Annotation) => {
    if (updatedAnn.id === undefined) return;
    
    try {
      await db.annotations.put(updatedAnn);
      setAnnotations(prev => prev.map(ann => ann.id === updatedAnn.id ? updatedAnn : ann).sort((a, b) => a.start - b.start));
    } catch (err) {
      console.error("Failed to update annotation", err);
    }
  };

  const handleDeleteAnnotation = async (id: number) => {
    try {
      await db.annotations.delete(id);
      setAnnotations(prev => prev.filter(ann => ann.id !== id));
      if (selectedAnnotation?.id === id) setSelectedAnnotation(null);
    } catch (err) {
      console.error("Failed to delete annotation", err);
    }
  };

  const handleSelectAnnotation = (ann: Annotation) => {
    setSelectedAnnotation(ann);
  };

  // --- Run Sound Event Detection ---
  const handleRunDetection = async () => {
    if (!activeSession || activeSession.id === undefined) return;
    
    setIsScanning(true);
    try {
      // Run the dynamic PCM detector in audioProcessor.ts
      const results = await detectVocalizations(activeSession.blob, { sensitivity, minDuration });
      
      // Clear existing detections for clean scan
      await db.annotations.where('sessionId').equals(activeSession.id).delete();
      
      // Insert all detections
      const savePromises = results.map(r => 
        db.annotations.add({
          sessionId: activeSession.id!,
          label: r.label,
          start: r.start,
          end: r.end,
          peakFreq: r.peakFreq
        })
      );
      
      await Promise.all(savePromises);
      
      // Reload annotations
      await loadAnnotations(activeSession.id);
    } catch (err) {
      console.error("Detection scan failed", err);
      alert("Error scanning audio file.");
    } finally {
      setIsScanning(false);
    }
  };

  const formatDuration = (sec: number) => {
    const mins = Math.floor(sec / 60);
    const remainder = sec % 60;
    return `${mins}:${remainder.toString().padStart(2, '0')}`;
  };

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', minHeight: '100vh', width: '100%', backgroundColor: 'var(--bg-color)', color: 'var(--text-primary)' }}>
      
      {/* Sidebar Panel */}
      <aside style={{ backgroundColor: '#1e1f22', borderRight: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>
        
        {/* Sidebar Header */}
        <div style={{ padding: '1.5rem', borderBottom: '1px solid var(--border-color)', display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{ backgroundColor: 'rgba(59, 130, 246, 0.15)', padding: '0.5rem', borderRadius: 8, color: '#3b82f6', display: 'flex', alignItems: 'center' }}>
            <Cpu size={24} />
          </div>
          <div>
            <h1 style={{ fontSize: '1.15rem', fontWeight: 700, margin: 0, letterSpacing: '-0.02em', color: '#fff' }}>Acoustic Field Station</h1>
            <span style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
              <span style={{ display: 'inline-block', width: '6px', height: '6px', backgroundColor: '#10b981', borderRadius: '50%' }}></span>
              Offline Ready
            </span>
          </div>
        </div>

        {/* Recording Widget */}
        <div style={{ padding: '1.25rem', borderBottom: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
          <h2 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
            Live Audio Capture
          </h2>
          
          {isRecording ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.85rem', color: '#ef4444', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }} className="pulse">
                  ● Recording
                </span>
                <span style={{ fontFamily: 'monospace', fontSize: '0.9rem', color: 'var(--text-primary)', fontWeight: 600 }}>
                  {formatDuration(recordingTime)}
                </span>
              </div>
              <canvas ref={canvasRef} width="280" height="50" style={{ borderRadius: 6, border: '1px solid rgba(255, 255, 255, 0.05)', display: 'block', width: '100%', height: '50px' }}></canvas>
              <button onClick={stopRecording} className="danger" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', padding: '0.65rem' }}>
                <Square size={16} fill="currentColor" /> Stop & Save
              </button>
            </div>
          ) : (
            <button onClick={startRecording} style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', color: '#ef4444', border: '1px solid rgba(239, 68, 68, 0.3)', padding: '0.65rem' }} className="record-btn">
              <Mic size={16} /> Record Mic
            </button>
          )}

          {/* Upload Button */}
          <div>
            <input 
              type="file" 
              accept="audio/*" 
              ref={fileInputRef} 
              onChange={handleFileUpload} 
              id="file-upload" 
            />
            <label htmlFor="file-upload" className="file-upload-btn" style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', margin: 0, textAlign: 'center', fontSize: '0.9em' }}>
              <Upload size={16} /> Upload Audio File
            </label>
          </div>
        </div>

        {/* Native Processor for Large Files (Tauri only) */}
        {isTauri && (
          <div style={{ padding: '0 1.25rem 1.25rem 1.25rem', borderBottom: '1px solid var(--border-color)' }}>
            <NativeProcessor />
          </div>
        )}

        {/* Sessions Directory */}
        <div style={{ padding: '1.25rem', flex: 1, display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <h2 style={{ fontSize: '0.8rem', fontWeight: 600, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', margin: 0 }}>
            Saved Sessions ({sessions.length})
          </h2>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', overflowY: 'auto', flex: 1, maxHeight: 'calc(100vh - 350px)' }} className="custom-scrollbar">
            {sessions.length === 0 ? (
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', fontStyle: 'italic', textAlign: 'center', marginTop: '1.5rem' }}>No recordings stored offline.</p>
            ) : (
              sessions.map((s) => {
                const isActive = activeSession?.id === s.id;
                return (
                  <div 
                    key={s.id}
                    onClick={() => setActiveSession(s)}
                    style={{
                      backgroundColor: isActive ? 'var(--bg-hover)' : 'transparent',
                      border: `1px solid ${isActive ? 'var(--accent-color)' : 'var(--border-color)'}`,
                      borderRadius: 8,
                      padding: '0.75rem',
                      cursor: 'pointer',
                      transition: 'all 0.2s',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: '0.5rem',
                    }}
                    className="session-card"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.65rem', minWidth: 0 }}>
                      <FileAudio size={18} style={{ color: isActive ? '#3b82f6' : 'var(--text-secondary)', flexShrink: 0 }} />
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: '0.85rem', fontWeight: 500, color: isActive ? '#fff' : 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>
                          {s.name}
                        </div>
                        <div style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem', marginTop: '0.15rem' }}>
                          <Calendar size={10} />
                          {new Date(s.createdAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}
                        </div>
                      </div>
                    </div>
                    {s.id !== undefined && (
                      <button 
                        title="Delete Session"
                        onClick={(e) => handleDeleteSession(s.id!, e)}
                        style={{ padding: '0.3rem', background: 'transparent', color: 'var(--text-secondary)', border: 'none' }}
                        className="delete-session-btn"
                      >
                        <Trash2 size={13} />
                      </button>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </aside>

      {/* Main Workstation */}
      <main style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflowY: 'auto', padding: '1.5rem 2rem 2rem 2rem', gap: '1.5rem' }}>
        
        {/* Main Header / Active Session Details */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', backgroundColor: 'var(--bg-panel)', padding: '1rem 1.5rem', borderRadius: 12, border: '1px solid var(--border-color)' }}>
          <div>
            <span style={{ fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-color)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Active Session Analysis
            </span>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 600, margin: '0.1rem 0 0 0', color: '#fff' }}>
              {activeSession ? activeSession.name : 'Select a recording to begin'}
            </h2>
          </div>
          
          {activeSession && (
            <div style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', display: 'flex', gap: '1.5rem' }}>
              <div>
                <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>FILE FORMAT</span>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>PCM (WAV)</span>
              </div>
              <div style={{ borderLeft: '1px solid var(--border-color)', paddingLeft: '1.5rem' }}>
                <span style={{ display: 'block', fontSize: '0.7rem', color: 'var(--text-secondary)' }}>RECORDED DATE</span>
                <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>
                  {new Date(activeSession.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Waveform and Spectrogram Visualizer */}
        <AudioVisualizer 
          blob={activeSession ? activeSession.blob : null}
          annotations={annotations}
          onAddAnnotation={handleAddAnnotation}
          onUpdateAnnotation={handleUpdateAnnotation}
          selectedAnnotation={selectedAnnotation}
        />

        {activeSession && (
          <div style={{ display: 'grid', gridTemplateColumns: '320px 1fr', gap: '1.5rem', alignItems: 'start' }}>
            
            {/* Auto-Detection Control Panel */}
            <div style={{ backgroundColor: 'var(--bg-panel)', padding: '1.25rem', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', borderBottom: '1px solid var(--border-color)', paddingBottom: '0.75rem' }}>
                <Brain size={18} style={{ color: 'var(--accent-color)' }} />
                <h3 style={{ margin: 0, fontSize: '0.95rem', fontWeight: 600 }}>Acoustic Buzz Classifier</h3>
              </div>

              {/* Slider: Sensitivity */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', gap: '0.25rem' }}>
                    <Sliders size={12} /> Sensitivity
                  </span>
                  <span style={{ fontWeight: 600, color: 'var(--accent-color)' }}>{sensitivity.toFixed(1)}</span>
                </div>
                <input 
                  type="range" 
                  min="1.0" 
                  max="5.0" 
                  step="0.2"
                  value={sensitivity} 
                  onChange={(e) => setSensitivity(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-color)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                  Lower: detects louder calls. Higher: picks up faint acoustic events.
                </span>
              </div>

              {/* Slider: Min Call Duration */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                  <span style={{ color: 'var(--text-secondary)' }}>Min Duration</span>
                  <span style={{ fontWeight: 600, color: 'var(--accent-color)' }}>{minDuration.toFixed(2)}s</span>
                </div>
                <input 
                  type="range" 
                  min="0.05" 
                  max="2.0" 
                  step="0.05"
                  value={minDuration} 
                  onChange={(e) => setMinDuration(Number(e.target.value))}
                  style={{ width: '100%', accentColor: 'var(--accent-color)', cursor: 'pointer' }}
                />
                <span style={{ fontSize: '0.68rem', color: 'var(--text-secondary)' }}>
                  Filters out short transients like mic noise or twig snaps.
                </span>
              </div>

              <button 
                onClick={handleRunDetection} 
                className="primary" 
                disabled={isScanning}
                style={{ 
                  display: 'flex', 
                  alignItems: 'center', 
                  justifyContent: 'center', 
                  gap: '0.5rem', 
                  padding: '0.75rem',
                  opacity: isScanning ? 0.7 : 1,
                  cursor: isScanning ? 'not-allowed' : 'pointer'
                }}
              >
                {isScanning ? (
                  <>
                    <span className="spinner"></span> Scanning...
                  </>
                ) : (
                  <>
                    <Cpu size={16} /> Run Detector
                  </>
                )}
              </button>
            </div>

            {/* Interactive Annotation Table */}
            <AnnotationTable 
              annotations={annotations}
              onSelectAnnotation={handleSelectAnnotation}
              onDeleteAnnotation={handleDeleteAnnotation}
              onEditAnnotation={handleUpdateAnnotation}
            />

          </div>
        )}

      </main>
    </div>
  );
}

export default App;
