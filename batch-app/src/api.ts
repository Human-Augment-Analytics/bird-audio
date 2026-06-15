import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { StartOpts, StartResult, Summary, FileRow, Progress, HealthStatus } from "./types";

export const checkHealth = (cwd?: string) => 
  invoke<HealthStatus>("check_health", { cwd });
export const prepareSystem = (cwd?: string) => 
  invoke<void>("prepare_system", { cwd });

export const pickFolder = () => invoke<string | null>("pick_folder");
export const pickSavePath = (defaultName: string) =>
  invoke<string | null>("pick_save_path", { defaultName });
export const startSession = (opts: StartOpts) => invoke<StartResult>("start_session", { opts });
export const cancelSession = () => invoke<void>("cancel_session");
export const getSummary = (outputDir: string, sessionId: number) =>
  invoke<Summary>("get_summary", { outputDir, sessionId });
export const listFiles = (outputDir: string, sessionId: number) =>
  invoke<FileRow[]>("list_files", { outputDir, sessionId });
export const exportSession = (
  outputDir: string,
  sessionId: number,
  path: string,
  fmt: string,
  completeOnly: boolean
) => invoke<number>("export_session", { outputDir, sessionId, path, fmt, completeOnly });

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("batch://progress", (e) => cb(e.payload));
export const onDone = (cb: (s: Summary) => void): Promise<UnlistenFn> =>
  listen<Summary>("batch://done", (e) => cb(e.payload));
