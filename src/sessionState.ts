import type { FileRow, Progress, StartResult, Summary } from "./types";

export function isTerminalSessionStatus(status: string | null | undefined): boolean {
  return status === "done" || status === "cancelled" || status === "failed";
}

export function getRunCounts(
  start: StartResult,
  progress: Progress | null,
  summary: Summary | null,
  rows: readonly FileRow[],
) {
  const rowCounts = { done: 0, pending: 0, inProgress: 0, events: 0, complete: 0, retained: 0 };
  for (const row of rows) {
    switch (row.status) {
      case "done": rowCounts.done += 1; break;
      case "pending": rowCounts.pending += 1; break;
      case "in_progress": rowCounts.inProgress += 1; break;
    }
    rowCounts.events += row.n_events || 0;
    rowCounts.complete += row.n_complete || 0;
    rowCounts.retained += row.n_retained || 0;
  }

  // Progress events only fire when a file finishes. Polled rows reflect a claimed
  // file sooner, so prefer their pending/active counts while a run is live.
  const rowsLoaded = rows.length > 0;
  return {
    done: summary?.done ?? progress?.done ?? rowCounts.done,
    total: summary?.total ?? progress?.total ?? start.total_files,
    failed: summary?.failed ?? progress?.failed ?? 0,
    pending: summary?.pending ?? (rowsLoaded ? rowCounts.pending : progress?.pending ?? 0),
    inProgress: summary?.in_progress ?? (rowsLoaded ? rowCounts.inProgress : progress?.in_progress ?? 0),
    events: summary?.n_events ?? rowCounts.events,
    complete: summary?.n_complete ?? rowCounts.complete,
    retained: summary?.n_retained ?? rowCounts.retained,
  };
}
