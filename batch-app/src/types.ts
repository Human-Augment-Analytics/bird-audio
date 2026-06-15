export interface StartOpts {
  input: string;
  output_dir: string;
  device: string;
  concurrency: number;
  worker_cmd: string;
  cwd: string | null;
  theta_a: number;
  theta_b: number;
  timeout_secs: number;
  max_attempts: number;
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
