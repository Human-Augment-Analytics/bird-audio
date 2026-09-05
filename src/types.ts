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
  /** Analysis target. Omitted fields fall back to the Hume's Leaf Warbler defaults. */
  speciesName?: string | null;
  fMinHz?: number | null;
  fMaxHz?: number | null;
  localizer?: string | null;
  classifier?: string | null;
  classifierC?: string | null;
}

export interface StartResult {
  session_id: number;
  total_files: number;
}

export interface Progress {
  session_id: number;
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
  session_id: number;
  status: "running" | "done" | "cancelled" | "failed" | string;
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
  n_retained: number;
  error: string | null;
}

export interface CachedFile {
  path: string;
  status: string;
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

export type VerificationStrategy = "random" | "stratified" | "uncertainty" | "completeness";

/** Where the seconds-per-verification figure came from. An assumed pace is not a measurement. */
export interface VerificationPace {
  seconds_per_verification: number;
  source: "measured" | "flag" | "assumed";
  n_decisions: number | null;
  mean_seconds?: number;
  idle_cutoff_ms?: number;
}

export interface VerificationPrecision {
  threshold: number;
  n_verified: number;
  n_true: number;
  /** null, never 0, when nothing above the threshold has been verified. */
  point: number | null;
  ci_low: number;
  ci_high: number;
  half_width: number;
  n_above_threshold: number;
  n_unreviewed: number;
  confidence: number;
}

export interface VerificationEffort {
  n_verified: number;
  n_required: number;
  n_additional: number;
  n_available: number;
  p_assumed: number;
  target_half_width: number;
  seconds_per_verification: number;
  estimated_seconds: number;
  estimated_minutes: number;
  requires_census: boolean;
}

export interface VerificationQueueItem {
  id: number;
  stage_a_conf: number;
  completeness_score: number | null;
  file_id: number;
  path: string;
}

export interface VerificationPlan {
  db: string;
  session_id: number | null;
  threshold: number;
  theta_b: number;
  strategy: VerificationStrategy;
  budget: number;
  seed: number;
  pace: VerificationPace;
  precision: VerificationPrecision;
  effort: VerificationEffort;
  stopping_rule: { stop: boolean; reason: string };
  queue: VerificationQueueItem[];
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
  human_completeness: ManualCompletenessDecision | null;
  completeness_source: ManualCompletenessSource | null;
  retained: boolean | null;
  n_members: number;
  review_status: "unreviewed" | "confirmed" | "rejected";
  source: "ml" | "manual";
  label: string | null;
  note: string | null;
  reviewed_at: string | null;
  stage_c_label: string | null;
  stage_c_score: number | null;
}

export type ManualCompletenessDecision = "complete" | "incomplete" | "unsure";
export type ManualCompletenessSource = "human" | "stage_b_accepted" | "unresolved";
