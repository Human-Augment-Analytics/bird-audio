// Run with: node --experimental-strip-types --test tests/sessionState.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { getRunCounts, isTerminalSessionStatus } from "../src/sessionState.ts";

const start = Object.freeze({ session_id: 42, total_files: 12 });
const row = (status, n_events = 0, n_complete = 0, n_retained = 0) =>
  Object.freeze({ path: `${status}.wav`, status, n_events, n_complete, n_retained, error: null });
const rows = Object.freeze([
  row("done", 5, 3, 2),
  row("done", 2, 1, 1),
  row("pending"),
  row("in_progress", 1),
  row("failed", 3, 2, 1),
  row("unknown", 4, 1, 2),
]);
const progress = Object.freeze({
  session_id: 42, total: 11, done: 4, failed: 2, pending: 5, in_progress: 0, last_file: null,
});

test("only the three exact terminal statuses finish a session", () => {
  for (const status of ["done", "cancelled", "failed"]) {
    assert.equal(isTerminalSessionStatus(status), true, status);
  }
  for (const status of [null, undefined, "", "running", "pending", "in_progress", "Done", "done ", "unknown"]) {
    assert.equal(isTerminalSessionStatus(status), false, String(status));
  }
});

test("a new session uses the start total until snapshots arrive", () => {
  assert.deepEqual(getRunCounts(start, null, null, []), {
    done: 0, total: 12, failed: 0, pending: 0, inProgress: 0, events: 0, complete: 0, retained: 0,
  });
});

test("row fallback counts known work states and sums detections from every status", () => {
  assert.deepEqual(getRunCounts(start, null, null, rows), {
    done: 2, total: 12, failed: 0, pending: 1, inProgress: 1, events: 15, complete: 7, retained: 6,
  });
});

test("live rows replace stale pending/active counts while progress supplies processed/failed totals", () => {
  assert.deepEqual(getRunCounts(start, progress, null, rows), {
    done: 4, total: 11, failed: 2, pending: 1, inProgress: 1, events: 15, complete: 7, retained: 6,
  });
  assert.deepEqual(getRunCounts(start, progress, null, []), {
    done: 4, total: 11, failed: 2, pending: 5, inProgress: 0, events: 0, complete: 0, retained: 0,
  });
});

test("loaded rows with zero pending/active work still take precedence over progress", () => {
  const staleProgress = { ...progress, in_progress: 3 };
  assert.deepEqual(getRunCounts(start, staleProgress, null, [row("done")]), {
    done: 4, total: 11, failed: 2, pending: 0, inProgress: 0, events: 0, complete: 0, retained: 0,
  });
});

test("all summary counts, including zero, override progress and rows for every terminal status", () => {
  for (const status of ["done", "cancelled", "failed"]) {
    const summary = Object.freeze({
      session_id: 42, status, total: 0, done: 0, failed: 0, pending: 0, in_progress: 0,
      n_events: 0, n_complete: 0, n_retained: 0,
    });
    assert.deepEqual(getRunCounts(start, progress, summary, rows), {
      done: 0, total: 0, failed: 0, pending: 0, inProgress: 0, events: 0, complete: 0, retained: 0,
    });
  }
});

test("each missing summary count falls back independently", () => {
  const summary = {
    session_id: 42, status: "done", done: 0, total: null, failed: undefined, pending: null,
    in_progress: undefined, n_events: 0, n_complete: null, n_retained: undefined,
  };
  assert.deepEqual(getRunCounts(start, progress, summary, rows), {
    done: 0, total: 11, failed: 2, pending: 1, inProgress: 1, events: 0, complete: 7, retained: 6,
  });
});

test("missing and non-numeric row detection counts retain the existing zero fallback", () => {
  assert.deepEqual(getRunCounts(start, null, null, [row("done", null, undefined, NaN)]), {
    done: 1, total: 12, failed: 0, pending: 0, inProgress: 0, events: 0, complete: 0, retained: 0,
  });
});
