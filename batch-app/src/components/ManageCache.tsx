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
    <div className="cache">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <h4 className="eyebrow" style={{ color: "var(--violet)" }}>Previous results cached</h4>
        <div style={{ display: "flex", gap: 6 }}>
          <button className="chip" onClick={selectAll}>All</button>
          <button className="chip" onClick={selectNone}>None</button>
          <button className="chip" onClick={selectFailed}>Failed</button>
        </div>
      </div>

      <div className="cache__list">
        {files.map(f => (
          <label key={f.path} className="cache__row">
            <input
              type="checkbox"
              checked={selected.has(f.path)}
              onChange={() => toggle(f.path)}
            />
            <span style={{ flex: 1, textOverflow: "ellipsis", overflow: "hidden", whiteSpace: "nowrap" }}>
              {f.path.split('/').pop()}
            </span>
            <span className="status-pill" style={{ color: f.status === 'done' ? 'var(--jade)' : f.status === 'failed' ? 'var(--coral)' : 'var(--text-faint)' }}>
              {f.status}
            </span>
          </label>
        ))}
        {files.length === 0 && (
          <div className="empty">No files found in cache.</div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        <button className="primary" style={{ fontSize: 12, padding: "7px 14px" }} onClick={handleClear} disabled={busy || selected.size === 0}>
          {busy ? "Clearing…" : `Clear ${selected.size} selected`}
        </button>
      </div>
    </div>
  );
}
