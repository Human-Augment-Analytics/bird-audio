import type { CachedFile } from "./types";

export const STAGE_LABEL: Record<CachedFile["stage"], string> = {
  pending: "Not run yet",
  stage_a: "Stage A only",
  complete: "Complete",
};

export const STAGE_COLOR: Record<CachedFile["stage"], string> = {
  pending: "var(--text-faint)",
  stage_a: "var(--amber)",
  complete: "var(--jade)",
};
