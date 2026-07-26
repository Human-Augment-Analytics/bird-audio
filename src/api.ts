import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { StartOpts, StartResult, Summary, FileRow, Progress, HealthStatus, CachedFile, ExportedEvent, EventRow } from "./types";

export const checkHealth = (
  cwd?: string,
  models?: { localizer?: string | null; classifier?: string | null; classifierC?: string | null }
) =>
  invoke<HealthStatus>("check_health", {
    cwd,
    localizer: models?.localizer ?? null,
    classifier: models?.classifier ?? null,
    classifierC: models?.classifierC ?? null,
  });
export const prepareSystem = (cwd?: string) => 
  invoke<void>("prepare_system", { cwd });
export const checkCache = (outputDir: string) =>
  invoke<boolean>("check_cache", { outputDir });
export const clearCache = (outputDir: string) =>
  invoke<void>("clear_cache", { outputDir });
export const getCachedFiles = (outputDir: string) =>
  invoke<CachedFile[]>("get_cached_files", { outputDir });
export const deleteCachedFiles = (outputDir: string, paths: string[]) =>
  invoke<void>("delete_cached_files", { outputDir, paths });

export const pickFolder = async (): Promise<string | null> => {
  const result = await open({ directory: true, multiple: false });
  return typeof result === "string" ? result : null;
};
export const pickFile = async (filters?: { name: string; extensions: string[] }[]): Promise<string | null> => {
  const result = await open({ directory: false, multiple: false, filters });
  return typeof result === "string" ? result : null;
};
export const pickSavePath = async (defaultName: string): Promise<string | null> => {
  const result = await save({ defaultPath: defaultName });
  return typeof result === "string" ? result : null;
};
export const startSession = (opts: StartOpts) => invoke<StartResult>("start_session", { opts });
export const cancelSession = () => invoke<void>("cancel_session");
export const getSummary = (outputDir: string, sessionId: number) =>
  invoke<Summary>("get_summary", { outputDir, sessionId });
export const listFiles = (outputDir: string, sessionId: number) =>
  invoke<FileRow[]>("list_files", { outputDir, sessionId });
export const getSessionEvents = (outputDir: string, sessionId: number) =>
  invoke<ExportedEvent[]>("get_session_events", { outputDir, sessionId });
export const exportSession = (
  outputDir: string,
  sessionId: number,
  path: string,
  fmt: string,
  completeOnly: boolean,
  confirmedOnly: boolean,
  metadataPath?: string | null
) => invoke<number>("export_session", { outputDir, sessionId, path, fmt, completeOnly, confirmedOnly, metadataPath });

export const onProgress = (cb: (p: Progress) => void): Promise<UnlistenFn> =>
  listen<Progress>("batch://progress", (e) => cb(e.payload));
export const onDone = (cb: (s: Summary) => void): Promise<UnlistenFn> =>
  listen<Summary>("batch://done", (e) => cb(e.payload));

export const getConcurrencySuggestion = (device: string) =>
  invoke<{ logical: number; recommended: number }>("concurrency_suggestion", { device });

export const getFeatureFlags = (cwd?: string) =>
  invoke<Record<string, any>>("get_feature_flags", { cwd });
export const listEvents = (outputDir: string, sessionId: number, path: string) =>
  invoke<EventRow[]>("list_events", { outputDir, sessionId, path });
export const setEventReview = (
  outputDir: string, eventId: number, status: string,
  label?: string | null, note?: string | null
) => invoke<void>("set_event_review", { outputDir, eventId, status, label, note });
export const updateEventBounds = (
  outputDir: string, eventId: number, tStart: number, tEnd: number, fLow: number, fHigh: number
) => invoke<void>("update_event_bounds", { outputDir, eventId, tStart, tEnd, fLow, fHigh });
export const addManualEvent = (
  outputDir: string, sessionId: number, path: string,
  b: { tStart: number; tEnd: number; fLow: number; fHigh: number }
) => invoke<number>("add_manual_event", { outputDir, sessionId, path, tStart: b.tStart, tEnd: b.tEnd, fLow: b.fLow, fHigh: b.fHigh });
export const deleteEvent = (outputDir: string, eventId: number) =>
  invoke<void>("delete_event", { outputDir, eventId });
export const prepareReview = (outputDir: string, sessionId: number) =>
  invoke<void>("prepare_review", { outputDir, sessionId });

/** Telemetry is best-effort: a logging failure must never interrupt review. */
export const logReviewAction = (
  outputDir: string, sessionId: number, action: string,
  eventId?: number | null, meta?: Record<string, unknown> | null
): Promise<void> =>
  invoke<void>("log_review_action", {
    outputDir, sessionId, action, eventId,
    meta: meta ? JSON.stringify(meta) : null,
  }).catch(() => undefined);

export const getReviewTelemetry = (outputDir: string, sessionId: number) =>
  invoke<Record<string, unknown>>("get_review_telemetry", { outputDir, sessionId });
export const audioSrc = (path: string): string => convertFileSrc(path);
