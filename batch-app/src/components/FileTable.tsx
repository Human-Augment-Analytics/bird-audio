import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { FileRow } from "../types";

const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  in_progress: "Processing",
  done: "Complete",
  failed: "Failed",
};

const STATUS_COLORS: Record<string, string> = {
  pending: "#9aa0aa",
  in_progress: "#fbbf24",
  done: "#10b981",
  failed: "#f87171",
};

export default function FileTable({ rows }: { rows: FileRow[] }) {
  const parentRef = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 32,
    overscan: 15,
  });

  return (
    <div
      ref={parentRef}
      style={{ 
        height: 420, overflow: "auto", border: "1px solid #1f2228", borderRadius: 8,
        background: "rgba(0,0,0,0.1)"
      }}
    >
      <div style={{ height: v.getTotalSize(), position: "relative" }}>
        {v.getVirtualItems().map((item) => {
          const r = rows[item.index];
          return (
            <div
              key={item.index}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                transform: `translateY(${item.start}px)`,
                height: 32,
                width: "100%",
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "0 16px",
                fontSize: 12,
                borderBottom: "1px solid #1f2228",
              }}
            >
              <span style={{ width: 85, color: STATUS_COLORS[r.status] ?? "#e6e7ea", fontWeight: 500 }}>
                {STATUS_LABELS[r.status] ?? r.status}
              </span>
              <span
                style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                title={r.path}
              >
                {r.path.split("/").pop() || r.path}
              </span>
              <span style={{ width: 90, textAlign: "right", color: "#9aa0aa" }}>
                {r.n_events} detections
              </span>
              {r.error && (
                <span
                  style={{
                    width: 200,
                    color: "#f87171",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={r.error}
                >
                  {r.error}
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
