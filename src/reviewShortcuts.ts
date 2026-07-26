import { useEffect } from "react";
import type { EventRow } from "./types";

export type ReviewDecision = "confirmed" | "rejected" | "unreviewed";

export interface ShortcutBinding {
  keys: string;
  description: string;
}

export const REVIEW_SHORTCUTS: ShortcutBinding[] = [
  { keys: "J / ↓", description: "Next event" },
  { keys: "K / ↑", description: "Previous event" },
  { keys: "C", description: "Confirm and advance" },
  { keys: "X", description: "Reject and advance" },
  { keys: "U", description: "Mark unreviewed" },
  { keys: "N", description: "Jump to next unreviewed" },
  { keys: "?", description: "Toggle this help" },
];

export function stepEventId(
  events: EventRow[],
  selectedId: number | null,
  delta: 1 | -1,
): number | null {
  if (events.length === 0) return null;
  const index = events.findIndex((e) => e.id === selectedId);
  if (index === -1) return delta === 1 ? events[0].id : events[events.length - 1].id;
  const next = index + delta;
  if (next < 0 || next >= events.length) return events[index].id;
  return events[next].id;
}

/**
 * Wraps to the start so a reviewer who jumps around still reaches skipped events;
 * returns null only when every event has been decided.
 */
export function nextUnreviewedId(events: EventRow[], selectedId: number | null): number | null {
  if (events.length === 0) return null;
  const start = events.findIndex((e) => e.id === selectedId);
  for (let offset = 1; offset <= events.length; offset++) {
    const candidate = events[(start + offset + events.length) % events.length];
    if (candidate.review_status === "unreviewed") return candidate.id;
  }
  return null;
}

function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}

export interface ReviewShortcutHandlers {
  events: EventRow[];
  selectedId: number | null;
  enabled: boolean;
  onSelect: (id: number) => void;
  onDecide: (id: number, status: ReviewDecision) => void | Promise<void>;
  onToggleHelp: () => void;
  onAction?: (action: string, meta?: Record<string, unknown>) => void;
}

export function useReviewShortcuts({
  events, selectedId, enabled, onSelect, onDecide, onToggleHelp, onAction,
}: ReviewShortcutHandlers) {
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      if (isTextEntry(ev.target)) return;

      const key = ev.key;
      const decide = (status: ReviewDecision, advance: boolean) => {
        if (selectedId === null) return;
        ev.preventDefault();
        onAction?.(status, { eventId: selectedId, via: "keyboard" });
        void onDecide(selectedId, status);
        if (advance) {
          const next = stepEventId(events, selectedId, 1);
          if (next !== null && next !== selectedId) onSelect(next);
        }
      };

      switch (key) {
        case "j": case "J": case "ArrowDown": {
          ev.preventDefault();
          const next = stepEventId(events, selectedId, 1);
          if (next !== null) { onSelect(next); onAction?.("nav_next", { eventId: next }); }
          break;
        }
        case "k": case "K": case "ArrowUp": {
          ev.preventDefault();
          const prev = stepEventId(events, selectedId, -1);
          if (prev !== null) { onSelect(prev); onAction?.("nav_prev", { eventId: prev }); }
          break;
        }
        case "c": case "C": decide("confirmed", true); break;
        case "x": case "X": decide("rejected", true); break;
        case "u": case "U": decide("unreviewed", false); break;
        case "n": case "N": {
          ev.preventDefault();
          const target = nextUnreviewedId(events, selectedId);
          if (target !== null) { onSelect(target); onAction?.("nav_unreviewed", { eventId: target }); }
          break;
        }
        case "?": ev.preventDefault(); onToggleHelp(); break;
        default: break;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [events, selectedId, enabled, onSelect, onDecide, onToggleHelp, onAction]);
}
