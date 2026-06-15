import { useEffect, useState } from "react";
import { getCachedFiles, deleteCachedFiles, clearCache } from "../api";
import type { CachedFile } from "../types";

interface Props {
  outputDir: string;
  onClose: () => void;
  onCleared: () => void;
}

export default function ManageCache({ outputDir, onClose, onCleared }: Props) {
  const [files, setFiles] = useState<CachedFile[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    getCachedFiles(outputDir).then(setFiles);
  }, [outputDir]);

  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  };

  const selectAll = () => setSelected(new Set(files.map(f => f.path)));
  const selectNone = () => setSelected(new Set());
  const selectFailed = () => setSelected(new Set(files.filter(f => f.status === 'failed').map(f => f.path)));

  const handleClear = async () => {
    if (selected.size === 0) return;
    setBusy(true);
    try {
      if (selected.size === files.length) {
        await clearCache(outputDir); // Nuke the whole DB if all selected
      } else {
        await deleteCachedFiles(outputDir, Array.from(selected));
      }
      onCleared();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      position: "fixed", top: 0, left: 0, right: 0, bottom: 0,
      background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100
    }}>
      <div className="card" style={{ width: 600, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
        <h3>Manage Previous Results</h3>
        <p style={{ fontSize: 13, color: "#9aa0aa" }}>Select files to remove from the cache so they will be re-analyzed.</p>
        
        <div style={{ display: "flex", gap: 8, margin: "12px 0" }}>
          <button style={{ fontSize: 12 }} onClick={selectAll}>Select All</button>
          <button style={{ fontSize: 12 }} onClick={selectNone}>Select None</button>
          <button style={{ fontSize: 12 }} onClick={selectFailed}>Select Failed</button>
        </div>

        <div style={{ flex: 1, overflowY: "auto", border: "1px solid #1f2228", borderRadius: 6, padding: 8 }}>
          {files.map(f => (
            <label key={f.path} style={{ display: "flex", gap: 12, padding: "4px 8px", cursor: "pointer", borderBottom: "1px solid #1f2228" }}>
              <input 
                type="checkbox" 
                checked={selected.has(f.path)} 
                onChange={() => toggle(f.path)} 
              />
              <span style={{ flex: 1, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
                {f.path.split('/').pop()}
              </span>
              <span style={{ color: f.status === 'done' ? '#10b981' : f.status === 'failed' ? '#f87171' : '#9aa0aa' }}>
                {f.status}
              </span>
            </label>
          ))}
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 12, marginTop: 16 }}>
          <button onClick={onClose} disabled={busy}>Cancel</button>
          <button className="primary" onClick={handleClear} disabled={busy || selected.size === 0}>
            {busy ? "Clearing..." : `Clear ${selected.size} Selected`}
          </button>
        </div>
      </div>
    </div>
  );
}
