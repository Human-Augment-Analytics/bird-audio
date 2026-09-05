# Developer guide

How to run Bird Audio Analyzer from source, test it, build installers, and cut a release. Researchers who only want to use the app should follow [Installing Bird Audio Analyzer](install.md) instead.

## Table of contents

1. [Prerequisites](#1-prerequisites)
2. [Clone and install](#2-clone-and-install)
3. [Run in development](#3-run-in-development)
4. [Tests](#4-tests)
5. [How the packaged app finds the pipeline](#5-how-the-packaged-app-finds-the-pipeline)
6. [Build installers locally](#6-build-installers-locally)
7. [Continuous integration and releases](#7-continuous-integration-and-releases)
8. [Headless CLI](#8-headless-cli)
9. [Analysis scripts](#9-analysis-scripts)

---

## 1. Prerequisites

| Tool | Why | Install |
| --- | --- | --- |
| **uv** | Python environment and dependencies for the ML pipeline | <https://github.com/astral-sh/uv> |
| **Rust + Cargo** | builds `batch-core` and the Tauri shell | <https://rustup.rs/> |
| **Tauri prerequisites** | platform webview and build tooling | <https://tauri.app/start/prerequisites/> |
| **Node.js 20+** | builds the React frontend | <https://nodejs.org/> |
| **git-lfs** | the detector models in `models/` are stored with Git LFS | <https://git-lfs.com/> |

---

## 2. Clone and install

```bash
git lfs install                 # once per machine
git clone https://github.com/Human-Augment-Analytics/bird-audio.git
cd bird-audio
npm install                     # frontend dependencies
uv sync                         # Python environment (.venv) for the ML pipeline
```

Check that the models are real files and not LFS pointers:

```bash
ls -la models/     # buzz_localizer.pt ≈ 49 MB, classifier.pt ≈ 25 MB
```

If they are a few hundred bytes, run `git lfs pull`.

---

## 3. Run in development

```bash
npm run tauri dev
```

The first launch compiles the Rust backend (a few minutes); later runs are incremental. In development the app uses the repository checkout directly: `scripts/`, `birdpipe/`, `models/` and the `.venv` that `uv sync` created. The health panel's **Prepare System** button runs `uv sync` in the checkout.

The frontend alone can be served with `npm run dev`, but the Tauri commands it calls will not exist.

---

## 4. Tests

```bash
uv run pytest -q                                # Python: birdpipe, scripts, worker protocol
cargo test -p batch-core                        # Rust engine, store, identity, export
cargo test --manifest-path src-tauri/Cargo.toml # Tauri commands and runtime root
npx tsc -p tsconfig.app.json --noEmit           # TypeScript
npm run lint
```

`tests/test_quarter_blocks.py` and `tests/test_consolidate.py` pin the numerical behaviour of the pipeline; if you touch `scripts/ml_engine.py` or `birdpipe/`, run them and compare a real file before and after (see `docs/architecture.md`, Reproducibility).

---

## 5. How the packaged app finds the pipeline

An installed copy has no repository, so the bundle carries everything the Python side needs as Tauri resources under `Contents/Resources/payload/` (macOS) or the equivalent resource directory on Windows and Linux:

```
payload/
├── scripts/*.py
├── birdpipe/*.py
├── config/features.yaml
├── models/buzz_localizer.pt, classifier.pt
├── pyproject.toml
├── uv.lock
└── .python-version
```

plus a `uv` binary shipped as a Tauri sidecar next to the app executable (`src-tauri/binaries/uv-<target-triple>`, downloaded by CI; `.gitignore`d).

At start-up `src-tauri/src/runtime.rs` decides the *project root*:

1. **Debug builds** and any build launched from inside a checkout use the repository (`models/` and `pyproject.toml` found next to the crate or by walking up from the executable or working directory).
2. Otherwise the payload is copied to a writable per-user directory, `<app data dir>/runtime` (for example `~/Library/Application Support/com.bird.audioanalyzer/runtime` on macOS). A `.payload-version` stamp records the app version; the copy is refreshed when the version changes, but the `.venv/` that `uv sync` created there is kept so updates do not re-download PyTorch.

Every command that shells out (`check_health`, `prepare_system`, the worker spawn, the analysis scripts) uses that root as its working directory and the sidecar `uv` when present, falling back to `~/.local/bin/uv`, Homebrew, `/usr/local/bin` and `PATH`.

The health check runs `uv run --no-sync python -c "import torch, ..."` so that a probe never starts the multi-gigabyte download on its own; **Prepare System** runs `uv sync`. `uv` downloads a managed CPython matching `.python-version` when the machine has none, so no system Python is required.

---

## 6. Build installers locally

Download the `uv` sidecar for your platform once (the CI workflow does the same):

```bash
mkdir -p src-tauri/binaries
# macOS Apple Silicon
curl -sL https://github.com/astral-sh/uv/releases/download/0.12.10/uv-aarch64-apple-darwin.tar.gz \
  | tar xz && mv uv-aarch64-apple-darwin/uv src-tauri/binaries/uv-aarch64-apple-darwin && rmdir uv-aarch64-apple-darwin
```

Then:

```bash
npm run tauri build                     # all bundle targets for this platform
npm run tauri build -- --bundles app    # macOS: just the .app, fastest for testing
```

Output lands in `target/release/bundle/`. To test as a user would, copy the `.app` to `/Applications` and launch it from there with a clean app-data directory:

```bash
rm -rf ~/Library/Application\ Support/com.bird.audioanalyzer
open "/Applications/Bird Audio Analyzer.app"
```

The console (or `Console.app`) shows `[bird-audio] pipeline root: …` on start-up. To force a cold Prepare System that really downloads everything, launch the binary directly with a fresh uv cache:

```bash
UV_CACHE_DIR=/tmp/uvcache UV_PYTHON_INSTALL_DIR=/tmp/uvpy \
  "/Applications/Bird Audio Analyzer.app/Contents/MacOS/bird-batch-gui"
```

Release builds ignore the compile-time checkout path on purpose, so the copy in `/Applications` behaves exactly like one on another machine.

The installers are not code-signed. macOS users must allow the app once in **System Settings, Privacy & Security** and Windows users click through SmartScreen; [install.md](install.md) documents both. Signing needs an Apple Developer ID and a Windows code-signing certificate; the Tauri action supports both through repository secrets when the project acquires them.

---

## 7. Continuous integration and releases

`.github/workflows/build-desktop.yml` builds the macOS (Apple Silicon), Windows and Linux installers with `tauri-apps/tauri-action`. It runs on:

- every push to `main`: creates a **draft** release tagged `v<version>` where the version comes from `src-tauri/tauri.conf.json`;
- every push to a `release-test/**` branch: creates a draft **pre-release** tagged `test-<run number>-v<version>` for trying an installer before merging;
- manual dispatch from the Actions tab.

The workflow checks out with Git LFS (and fails early if the model files are pointers), downloads the pinned `uv` sidecar per platform, then builds.

To cut a release:

1. Bump the version in `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (run `npm install --package-lock-only` and `cargo build` to refresh the lock files), commit, and merge to `main`.
2. Wait for the workflow. It uploads seven installers to a draft release.
3. Edit the draft: title, notes, and publish (`gh release edit v<version> --draft=false --latest --notes-file notes.md`).

A change to `scripts/ml_engine.py`, `birdpipe/`, or the models changes the session identity, so users who re-run a folder after updating get a fresh session (see `docs/architecture.md`, Reproducibility).

---

## 8. Headless CLI

```bash
cargo run -p batch-core --bin batch -- \
  --input data/ \
  --device cpu \
  --db data/batch.db \
  --export-csv events.csv
```

Same engine and database as the app: process overnight on the command line, then open the folder in the app to review. `--worker-cmd` and `--cwd` point the CLI at a different pipeline root, for example an installed app's runtime directory. Pass a path without spaces (a symlink is fine); the command string is split on whitespace.

---

## 9. Analysis scripts

Command-line tools under `scripts/` read a finished `batch.db`:

```bash
uv run python scripts/ecological_analysis.py --db data/batch.db --metadata deployments.csv --out out/ecology --measure-effort
uv run python scripts/threshold_sensitivity.py --db data/batch.db --out out/sensitivity
uv run python scripts/verification_planner.py --db data/batch.db --threshold 0.5 --target-half-width 0.05 --strategy uncertainty --budget 50
uv run python scripts/run_manifest.py --db data/batch.db --out out/manifest.json
uv run python scripts/export_protocol.py --db data/batch.db --out out/protocol
```

See [Advanced search and active learning](advanced-search-active-learning.md) and the [active learning tutorial](tutorial-active-learning.md) for the model-improvement loop, and [App reference](batch-app.md) for the Tauri command surface and schema.
