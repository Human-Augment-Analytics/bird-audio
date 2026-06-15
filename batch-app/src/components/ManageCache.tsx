import { useEffect, useState } from "react";
import { getCachedFiles, deleteCachedFiles, clearCache } from "../api";
import type { CachedFile } from "../types";

interface Props {
  outputDir: string;
  onCleared: () => void;
}

export default function ManageCache({ outputDir, onCleared }: Props) {
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
    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 12, padding: 16, background: "rgba(59, 130, 246, 0.05)", borderRadius: 8, border: "1px solid rgba(59, 130, 246, 0.2)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h4 style={{ margin: 0, fontSize: 14, color: "#9aa0aa" }}>Previous Results Cache</h4>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={selectAll}>Select All</button>
          <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={selectNone}>Select None</button>
          <button style={{ fontSize: 11, padding: "2px 8px" }} onClick={selectFailed}>Select Failed</button>
        </div>
      </div>
      
      <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid #1f2228", borderRadius: 6, padding: 4, background: "#15181e" }}>
        {files.map(f => (
          <label key={f.path} style={{ display: "flex", gap: 12, padding: "4px 8px", cursor: "pointer", borderBottom: "1px solid #1f2228" }}>
            <input 
              type="checkbox" 
              checked={selected.has(f.path)} 
              onChange={() => toggle(f.path)} 
            />
            <span style={{ flex: 1, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap", fontSize: 13 }}>
              {f.path.split('/').pop()}
            </span>
            <span style={{ fontSize: 13, color: f.status === 'done' ? '#10b981' : f.status === 'failed' ? '#f87171' : '#9aa0aa' }}>
              {f.status}
            </span>
          </label>
        ))}
        {files.length === 0 && (
          <div style={{ padding: 12, textAlign: "center", fontSize: 13, color: "#9aa0aa" }}>No files found in cache.</div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 4 }}>
        <button className="primary" style={{ fontSize: 12, padding: "6px 12px" }} onClick={handleClear} disabled={busy || selected.size === 0}>
          {busy ? "Clearing..." : `Clear ${selected.size} Selected`}
        </button>
      </div>
    </div>
  );
}
