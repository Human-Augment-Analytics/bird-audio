import type { DetectedEvent } from './audioProcessor';

export interface ConsolidationOptions {
  maxGapSeconds: number; // Maximum gap between events to be merged
}

/**
 * Merges overlapping or adjacent detection events.
 */
export function consolidateEvents(
  events: DetectedEvent[],
  options: ConsolidationOptions = { maxGapSeconds: 0.5 }
): DetectedEvent[] {
  if (events.length <= 1) return events;

  // Sort events by start time
  const sorted = [...events].sort((a, b) => a.start - b.start);
  const consolidated: DetectedEvent[] = [];

  let current = sorted[0];

  for (let i = 1; i < sorted.length; i++) {
    const next = sorted[i];

    // If next event starts within maxGapSeconds of current event's end
    if (next.start <= current.end + options.maxGapSeconds) {
      // Merge: extend end time and keep the higher peak frequency (or average)
      current = {
        ...current,
        end: Math.max(current.end, next.end),
        peakFreq: (current.peakFreq + next.peakFreq) / 2, // Simple average for now
        label: current.label === next.label ? current.label : `${current.label} / ${next.label}`
      };
    } else {
      consolidated.push(current);
      current = next;
    }
  }

  consolidated.push(current);
  return consolidated;
}
