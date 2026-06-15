import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StartOpts, StartResult, Summary, FileRow, Progress } from "./types";

export const pickFolder = () => invoke<string | null>("pick_folder");
export const pickSavePath = (default_name: string) =>
  invoke<string | null>("pick_save_path", { default_name });
export const startSession = (opts: StartOpts) => invoke<StartResult>("start_session", { opts });
export const cancelSession = () => invoke<void>("cancel_session");
export const getSummary = (output_dir: string, session_id: number) =>
  invoke<Summary>("get_summary", { output_dir, session_id });
export const listFiles = (output_dir: string, session_id: number) =>
  invoke<FileRow[]>("list_files", { output_dir, session_id });
export const exportSession = (
  output_dir: string,
  session_id: number,
  path: string,
  fmt: string,
  complete_only: boolean
) => invoke<number>("export_session", { output_dir, session_id, path, fmt, complete_only });

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("batch://progress", (e) => cb(e.payload));
export const onDone = (cb: (s: Summary) => void): Promise<UnlistenFn> =>
  listen<Summary>("batch://done", (e) => cb(e.payload));
