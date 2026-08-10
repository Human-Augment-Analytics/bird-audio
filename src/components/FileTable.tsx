import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileRow } from "../types";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "Listening",
  done: "Complete",
  failed: "Failed",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "var(--text-faint)",
  in_progress: "var(--amber)",
  done: "var(--jade)",
  failed: "var(--coral)",
};

export default function FileTable({ rows }: { rows: FileRow[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  // TanStack Virtual intentionally returns imperative helpers; React Compiler safely skips this hook.
  // eslint-disable-next-line react-hooks/incompatible-library
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 34,
    overscan: 15,
  });

  return (
    <div ref={parentRef} className="tablewrap" style={{ height: 420, overflow: "auto" }}>
      {rows.length === 0 ? (
        <div className="empty">No recordings to show in this view yet.</div>
      ) : (
        <div style={{ height: v.getTotalSize(), position: "relative" }}>
          {v.getVirtualItems().map((item) => {
            const r = rows[item.index];
            const color = STATUS_COLORS[r.status] ?? "var(--text)";
            return (
              <div
                key={item.index}
                className="trow"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  transform: `translateY(${item.start}px)`,
                  height: 34,
                  width: "100%",
                }}
              >
                <span className="status-pill" style={{ width: 96, color }}>
                  <span className="dot" style={{ background: color }} />
                  {STATUS_LABELS[r.status] ?? r.status}
                </span>
                <span className="trow__name" title={r.path}>
                  {r.path.split("/").pop() || r.path}
                </span>
                <span className="trow__count" style={{ width: 96 }}>
                  {r.n_events} {r.n_events === 1 ? "buzz" : "buzzes"}
                </span>
                {r.error && (
                  <span className="trow__err" style={{ width: 200 }} title={r.error}>
                    {r.error}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
