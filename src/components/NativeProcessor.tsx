import { useState } from 'react';
import { FileAudio, Play, Loader2, AlertCircle, CheckCircle2 } from 'lucide-react';
import { open } from '@tauri-apps/plugin-dialog';
import { Command } from '@tauri-apps/plugin-shell';

export function NativeProcessor() {
  const [filePath, setFilePath] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [output, setOutput] = useState<string>('');
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
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
      setError('Failed to open file dialog');
    }
  };

  const handleRunPipeline = async () => {
    if (!filePath) return;

    setIsProcessing(true);
    setOutput('Starting native pipeline...\n');
    setError(null);

    try {
      // Note: In a real production app, you'd want to bundle python or use a sidecar.
      // For this prototype, we assume 'python3' is in the system path.
      const command = Command.create('python3', [
        'scripts/ml_engine.py',
        '--input', filePath
      ]);

      command.on('close', data => {
        console.log(`command finished with code ${data.code} and signal ${data.signal}`);
        setIsProcessing(false);
      });

      command.on('error', error => {
        console.error(`command error: "${error}"`);
        setError(`Pipeline error: ${error}`);
        setIsProcessing(false);
      });

      command.stdout.on('data', line => {
        setOutput(prev => prev + line + '\n');
      });

      command.stderr.on('data', line => {
        console.warn(`Pipeline stderr: ${line}`);
      });

      const child = await command.spawn();
      console.log('Pipeline spawned with PID:', child.pid);

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
        Bypass browser memory limits for large recordings (1GB+) by using the native Python pipeline.
      </p>

      {!filePath ? (
        <button onClick={handleSelectFile} className="secondary" style={{ width: '100%', padding: '0.75rem' }}>
          Select Large Recording
        </button>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ backgroundColor: 'rgba(255, 255, 255, 0.05)', padding: '0.75rem', borderRadius: 6, fontSize: '0.8rem', border: '1px solid var(--border-color)', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <strong>Target:</strong> {filePath}
          </div>
          <div style={{ display: 'flex', gap: '0.5rem' }}>
            <button onClick={handleSelectFile} className="secondary" style={{ flex: 1, padding: '0.6rem' }} disabled={isProcessing}>
              Change File
            </button>
            <button onClick={handleRunPipeline} className="primary" style={{ flex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem' }} disabled={isProcessing}>
              {isProcessing ? <Loader2 size={16} className="spinner" /> : <Play size={16} />}
              {isProcessing ? 'Processing...' : 'Run Native Pipeline'}
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
            maxHeight: '200px', 
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
