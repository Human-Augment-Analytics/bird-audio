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
}

export interface Progress {
  total: number;
  done: number;
  failed: number;
  pending: number;
  in_progress: number;
  last_file: string | null;
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

export interface HealthStatus {
  env_ok: boolean;
  models_ok: boolean;
  device: string;
  details: string;
}
