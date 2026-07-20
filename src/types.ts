export interface StartOpts {
  input: string;
  outputDir: string;
  device: string;
  concurrency: number;
  workerCmd: string;
  cwd: string | null;
  thetaA: number;
  thetaB: number;
  timeoutSecs: number;
  maxAttempts: number;
}

export interface StartResult {
  session_id: number;
  total_files: number;
  /** Manifest rows dropped at start because the recording vanished from disk. */
  pruned: number;
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  in_progress: number;
  last_file: string | null;
  last_elapsed_ms?: number | null;
  elapsed_ms_total?: number;
}

export interface Summary {
  total: number;
  pending: number;
  in_progress: number;
  done: number;
  failed: number;
  n_events: number;
  n_complete: number;
  n_retained: number;
}

export interface FileRow {
  path: string;
  status: string;
  n_events: number;
  n_complete: number;
  error: string | null;
}

/** One per file as it reaches a terminal outcome (or is about to be retried) —
 * the payload of the un-throttled `batch://file_done` event. */
export interface FileDone {
  path: string;
  status: "done" | "failed" | "retry";
  n_events: number;
  n_complete: number;
  elapsed_ms: number;
  attempt: number;
  max_attempts: number;
  error: string | null;
}

export interface CachedFile {
  path: string;
  status: string;
  nEvents: number;
  nComplete: number;
  error: string | null;
  /** "pending" (not yet run), "stage_a" (detected, not classified), or "complete". */
  stage: "pending" | "stage_a" | "complete";
  /** True when this file's last run looks broken (errored, or interrupted mid-run). */
  broken: boolean;
}

export interface HealthStatus {
  env_ok: boolean;
  models_ok: boolean;
  device: string;
  internal_device: string;
  details: string;
}

export interface ExportedEvent {
  path: string;
  t_start: number;
  t_end: number;
  duration: number;
  f_low: number;
  f_high: number;
  center_freq: number;
  stage_a_conf: number;
  completeness_score: number | null;
  completeness_label: string | null;
  retained: boolean | null;
}

export interface EventRow {
  id: number;
  file_id: number;
  t_start: number;
  t_end: number;
  duration: number;
  f_low: number;
  f_high: number;
  center_freq: number;
  stage_a_conf: number;
  completeness_score: number | null;
  completeness_label: string | null;
  retained: boolean | null;
  n_members: number;
  review_status: "unreviewed" | "confirmed" | "rejected";
  source: "ml" | "manual";
  label: string | null;
  note: string | null;
}

