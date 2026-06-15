import { useState } from 'react';
import { FileAudio, Play, Loader2, AlertCircle, CheckCircle2, Database } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Command } from '@tauri-apps/plugin-shell';
import { db } from '../lib/db';

export function NativeProcessor() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [output, setOutput] = useState<string>('');
  const [detections, setDetections] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);

  const handleSelectFile = async () => {
    try {
      const selected = await open({
        multiple: false,
        filters: [{
          name: 'Audio',
          extensions: ['wav', 'mp3', 'flac']
        }]
      });
      if (selected && typeof selected === 'string') {
        setFilePath(selected);
        setError(null);
        setDetections([]);
        setOutput('');
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
      setError('Failed to open file dialog');
    }
  };

  const handleImportToDatabase = async () => {
    if (!filePath || detections.length === 0) return;

    try {
      // Create a dummy blob for the session (since it's local, we don't have the full blob in memory)
      const fileName = filePath.split('/').pop() || 'Native Recording';
      
      const sessionId = await db.sessions.add({
        name: `[Native] ${fileName}`,
        blob: new Blob([]), // Placeholder, native files aren't stored in IndexedDB
        createdAt: new Date()
      });

      const savePromises = detections.map(d => 
        db.annotations.add({
          sessionId: sessionId as number,
          label: d.label,
          start: d.start,
          end: d.end,
          peakFreq: d.peakFreq
        })
      );
      
      await Promise.all(savePromises);
      alert(`Imported ${detections.length} detections into database.`);
      
    } catch (err) {
      console.error('Failed to import detections:', err);
      setError('Failed to import to database');
    }
  };

  const handleRunPipeline = async () => {
    if (!filePath) return;

    setIsProcessing(true);
    setOutput('');
    setDetections([]);
    setError(null);

    try {
      const command = Command.create('python3', [
        'scripts/ml_engine.py',
        '--input', filePath
      ]);

      let jsonAccumulator = '';

      command.on('close', data => {
        setIsProcessing(false);
        if (data.code === 0) {
          try {
            // Parse the full accumulator; ml_engine prints pretty-formatted JSON
            const result = JSON.parse(jsonAccumulator.trim());
            
            if (result.status === 'error' || result.error) {
              setError(result.error || result.message || 'Unknown error');
            } else {
              // Map 'events' (new schema) to 'detections' (frontend state)
              // Rename fields to match what the import logic expects: 
              // t_start -> start, t_end -> end, completeness_label -> label, center_freq -> peakFreq
              const mapped = (result.events || []).map((e: any) => ({
                label: e.completeness_label || 'event',
                start: e.t_start,
                end: e.t_end,
                peakFreq: e.center_freq
              }));
              setDetections(mapped);
            }
          } catch (e) {
            console.error('Failed to parse pipeline output:', e);
            setError('Failed to parse pipeline results');
          }
        } else {
          setError(`Pipeline exited with code ${data.code}`);
        }
      });

      command.on('error', error => {
        setError(`Pipeline error: ${error}`);
        setIsProcessing(false);
      });

      command.stdout.on('data', line => {
        jsonAccumulator += line;
        // Check if line looks like progress/info (to show in log) or JSON (to hide)
        if (!line.trim().startsWith('{')) {
          setOutput(prev => prev + line);
        }
      });

      command.stderr.on('data', line => {
        setOutput(prev => prev + '[DEBUG] ' + line);
      });

      await command.spawn();

    } catch (err) {
      console.error('Failed to run pipeline:', err);
      setError(`Failed to start pipeline: ${err}`);
      setIsProcessing(false);
    }
  };

  return (
    <div style={{ backgroundColor: 'var(--bg-panel)', padding: '1.5rem', borderRadius: 12, border: '1px solid var(--border-color)', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <FileAudio size={24} style={{ color: 'var(--accent-color)' }} />
        <h3 style={{ margin: 0, fontSize: '1.1rem', fontWeight: 600 }}>Large File Native Processor</h3>
      </div>

      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', margin: 0 }}>
        High-performance Python/PyTorch backend for recordings (1GB+).
      </p>

      {!filePath ? (
        <button onClick={handleSelectFile} className="secondary" style={{ width: '100%', padding: '0.75rem' }}>
          Select Local WAV File
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', padding: '0.75rem', borderRadius: 6, fontSize: '0.8rem', border: '1px solid var(--border-color)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <strong>Local Path:</strong> {filePath}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={handleSelectFile} className="secondary" style={{ flex: 1, padding: '0.6rem' }} disabled={isProcessing}>
              Change
            </button>
            <button onClick={handleRunPipeline} className="primary" style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} disabled={isProcessing}>
              {isProcessing ? <Loader2 size={16} className="spinner" /> : <Play size={16} />}
              {isProcessing ? 'Run Pipeline' : 'Run Pipeline'}
            </button>
          </div>
        </div>
      )}

      {detections.length > 0 && (
        <div style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', padding: '1rem', borderRadius: 8, border: '1px solid rgba(16, 185, 129, 0.2)', display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '0.9rem', color: '#10b981', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
              <CheckCircle2 size={18} /> Found {detections.length} events
            </span>
            <button onClick={handleImportToDatabase} className="primary" style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
              <Database size={14} /> Import to DB
            </button>
          </div>
        </div>
      )}

      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#ef4444', fontSize: '0.85rem', backgroundColor: 'rgba(239, 68, 68, 0.1)', padding: '0.75rem', borderRadius: 6 }}>
          <AlertCircle size={16} />
          {error}
        </div>
      )}

      {output && (
        <div style={{ marginTop: '0.5rem' }}>
          <div style={{ fontSize: '0.75rem', color: 'var(--text-secondary)', marginBottom: '0.4rem', fontWeight: 600 }}>PIPELINE LOGS</div>
          <pre style={{ 
            backgroundColor: '#000', 
            color: '#10b981', 
            padding: '1rem', 
            borderRadius: 6, 
            fontSize: '0.75rem', 
            fontFamily: 'monospace', 
            maxHeight: '150px', 
            overflowY: 'auto',
            margin: 0,
            border: '1px solid rgba(16, 185, 129, 0.2)'
          }}>
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}
