import { useEffect, useState } from "react";
import { getCachedFiles, deleteCachedFiles, clearCache, cleanCache } from "../api";
import type { CachedFile } from "../types";
import { STAGE_LABEL, STAGE_COLOR } from "../stageMeta";
import { relativeDir } from "../pathTree";

interface Props {
  outputDir: string;
  /** Called after any deselected (excluded) files have been cleared, so the
   * caller can refresh its own counts and continue the setup flow. */
  onProceed: () => void;
}

export default function ManageCache({ outputDir, onProceed }: Props) {
  const [files, setFiles] = useState<CachedFile[]>([]);
  // Checked = "use this cached result". Starts with everything checked, so
  // doing nothing and clicking Proceed reuses the cache exactly as before.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [cleanNote, setCleanNote] = useState<string | null>(null);

  const reload = () =>
    getCachedFiles(outputDir).then((fs) => {
      setFiles(fs);
      setSelected(new Set(fs.map(f => f.path)));
    });

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outputDir]);

  // Tidy the cache so a re-run is trustworthy: re-queue broken files and drop
  // rows for recordings no longer on disk. Non-destructive to finished work.
  const handleClean = async () => {
    setBusy(true);
    setCleanNote(null);
    try {
      const { reset, pruned } = await cleanCache(outputDir);
      await reload();
      setCleanNote(
        reset === 0 && pruned === 0
          ? "Already tidy — nothing to clean up."
          : `Re-queued ${reset} broken file${reset === 1 ? "" : "s"}${pruned > 0 ? `, removed ${pruned} missing` : ""}.`
      );
    } finally {
      setBusy(false);
    }
  };

  const toggle = (path: string) => {
    const next = new Set(selected);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setSelected(next);
  };

  const brokenCount = files.filter(f => f.broken).length;
  const stageACount = files.filter(f => f.stage === "stage_a").length;
  const excludedCount = files.length - selected.size;

  const selectAll = () => setSelected(new Set(files.map(f => f.path)));
  const selectNone = () => setSelected(new Set());
  const excludeBroken = () => setSelected(new Set(files.filter(f => !f.broken).map(f => f.path)));
  const excludeStageAOnly = () => setSelected(new Set(files.filter(f => f.stage !== "stage_a").map(f => f.path)));

  const handleProceed = async () => {
    setBusy(true);
    try {
      const toClear = files.filter(f => !selected.has(f.path)).map(f => f.path);
      if (toClear.length > 0) {
        if (selected.size === 0) {
          await clearCache(outputDir); // nothing kept — nuke the whole DB
        } else {
          await deleteCachedFiles(outputDir, toClear);
        }
      }
      onProceed();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cache">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h4 className="eyebrow" style={{ color: "var(--violet)" }}>Previous results cached</h4>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button className="chip" onClick={selectAll}>Use all</button>
          <button className="chip" onClick={selectNone}>Use none</button>
          {brokenCount > 0 && (
            <button className="chip" style={{ color: "var(--coral)" }} onClick={excludeBroken}>
              Exclude broken ({brokenCount})
            </button>
          )}
          {stageACount > 0 && (
            <button className="chip" style={{ color: "var(--amber)" }} onClick={excludeStageAOnly}>
              Exclude Stage A only ({stageACount})
            </button>
          )}
          <button className="chip" onClick={handleClean} disabled={busy} title="Re-queue broken files and drop recordings no longer on disk">
            🧹 Tidy up
          </button>
        </div>
      </div>

      {cleanNote && (
        <div style={{ fontSize: 11, color: "var(--text-dim)" }}>{cleanNote}</div>
      )}

      {brokenCount > 0 && (
        <div className="error-text" style={{ margin: 0 }}>
          ⚠ {brokenCount} cached {brokenCount === 1 ? "file looks" : "files look"} broken (crashed or errored) —
          uncheck them below (or use "Exclude broken") to have them re-analyzed instead of reused.
        </div>
      )}

      <div className="cache__list">
        {files.map(f => {
          const dir = relativeDir(f.path, outputDir);
          return (
          <label
            key={f.path}
            className="cache__row"
            title={f.error ? `Error: ${f.error}` : f.path}
          >
            <input
              type="checkbox"
              checked={selected.has(f.path)}
              onChange={() => toggle(f.path)}
            />
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
              {dir && (
                <span style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--text-faint)",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {dir}/
                </span>
              )}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {f.broken && <span style={{ color: "var(--coral)", marginRight: 6 }}>⚠</span>}
                {f.path.split('/').pop()}
              </span>
            </span>
            {f.status === "done" && (
              <span className="status-pill" style={{ color: STAGE_COLOR[f.stage] }}>
                {STAGE_LABEL[f.stage]}
              </span>
            )}
            <span className="status-pill" style={{ color: f.status === 'done' ? 'var(--jade)' : f.status === 'failed' || f.broken ? 'var(--coral)' : 'var(--text-faint)' }}>
              {f.status}
            </span>
          </label>
          );
        })}
        {files.length === 0 && (
          <div className="empty">No files found in cache.</div>
        )}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <span style={{ fontSize: 11, color: "var(--text-faint)" }}>
          {excludedCount > 0
            ? `${excludedCount} unchecked recording${excludedCount === 1 ? "" : "s"} will be re-analyzed.`
            : "Everything checked — nothing will be re-analyzed."}
        </span>
        <button className="primary" style={{ fontSize: 12, padding: "7px 14px" }} onClick={handleProceed} disabled={busy}>
          {busy ? "Applying…" : `Use ${selected.size} of ${files.length} →`}
        </button>
      </div>
    </div>
  );
}
