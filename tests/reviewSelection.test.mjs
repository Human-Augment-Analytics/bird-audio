// Run with: node --test tests/reviewSelection.test.mjs
// Uses the installed TypeScript compiler; no browser or test dependencies needed.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const source = readFileSync(new URL("../src/components/ReviewView.tsx", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function createReview() {
  const slots = [];
  const requests = [];
  let cursor = 0;
  const dependencies = {
    react: {
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = initial;
        return [slots[index], (next) => {
          slots[index] = typeof next === "function" ? next(slots[index]) : next;
        }];
      },
      useRef(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = { current: initial };
        return slots[index];
      },
      useCallback: (callback) => callback,
      useMemo: (callback) => callback(),
      useEffect() {},
    },
    "react/jsx-runtime": {
      jsx: (type, props) => ({ type, props }),
      jsxs: (type, props) => ({ type, props }),
      Fragment: "Fragment",
    },
    "../api": {
      listEvents(_dir, _sid, path) {
        const request = { path, ...deferred() };
        requests.push(request);
        return request.promise;
      },
      logReviewAction: async () => {},
      audioSrc: (path) => path,
    },
    "./AudioVisualizer": { AudioVisualizer: "AudioVisualizer" },
    "./EventTable": { EventTable: "EventTable" },
    "./VerificationPanel": { __esModule: true, default: "VerificationPanel" },
    "../reviewShortcuts": { REVIEW_SHORTCUTS: [], useReviewShortcuts() {} },
  };
  const exports = {};
  new Function("require", "exports", compiled)((name) => {
    assert.ok(name in dependencies, `Unexpected dependency: ${name}`);
    return dependencies[name];
  }, exports);

  function render() {
    cursor = 0;
    const tree = exports.default({
      start: { session_id: 1 }, opts: { outputDir: "/review" },
      rows: ["first.wav", "second.wav"].map((path) => ({ path, status: "done" })),
    });
    const nodes = [];
    function visit(node) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      nodes.push(node);
      visit(node.props?.children);
    }
    visit(tree);
    return {
      select: nodes.find((node) => node.type === "VerificationPanel").props.onSelectEvent,
      open: (path) => nodes.find((node) => node.props.className === "ba-file" && node.props.title === path).props.onClick(),
      notice: nodes.find((node) => node.props.className === "notice reveal")?.props.children[0] ?? null,
      audio: nodes.find((node) => node.type === "AudioVisualizer")?.props,
    };
  }
  return { render, requests };
}

// Drain both the API await and the caller's promise continuation.
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("verification selection preserves an event-load failure", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.requests[0].reject(new Error("database unavailable"));
  await flush();
  assert.equal(review.render().notice, "Failed to load events: Error: database unavailable");
});

test("late events from an earlier recording cannot alter the active selection or notice", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.render().select(20, "second.wav");
  review.requests[1].resolve([{ id: 20 }]);
  await flush();
  review.requests[0].resolve([{ id: 10 }]);
  await flush();
  const view = review.render();
  assert.equal(view.notice, null);
  assert.equal(view.audio.src, "second.wav");
  assert.equal(view.audio.selectedId, 20);
  assert.deepEqual(view.audio.events, [{ id: 20 }]);
});

test("superseded requests stay stale after returning to the same recording", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.render().select(20, "second.wav");
  review.render().select(30, "first.wav");
  review.requests[2].resolve([{ id: 30 }]);
  await flush();
  review.requests[0].resolve([{ id: 10 }]);
  review.requests[1].reject(new Error("old request failed"));
  await flush();
  const view = review.render();
  assert.equal(view.notice, null);
  assert.equal(view.audio.selectedId, 30);
});

test("switching recordings between fetch completion and its continuation cannot select an old event", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.requests[0].resolve([{ id: 10 }]);
  await Promise.resolve();
  review.render().open("second.wav");
  review.requests[1].resolve([]);
  await flush();
  const view = review.render();
  assert.equal(view.audio.src, "second.wav");
  assert.equal(view.audio.selectedId, null);
  assert.equal(view.notice, null);
});

test("a successful empty response reports a genuinely missing verification event", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.requests[0].resolve([]);
  await flush();
  assert.equal(review.render().notice, "Verification event #10 was not found in first.wav.");
});

test("a successful response selects the requested verification event", async () => {
  const review = createReview();
  review.render().select(10, "first.wav");
  review.requests[0].resolve([{ id: 9 }, { id: 10 }]);
  await flush();
  const view = review.render();
  assert.equal(view.notice, null);
  assert.equal(view.audio.selectedId, 10);
});
