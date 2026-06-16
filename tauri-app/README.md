Bird Audio — Tauri App

Prerequisites
- Rust toolchain (stable) — see https://rustup.rs
- Node 16+ and npm
- `@tauri-apps/cli` will be installed by `npm install` as a devDependency

Quick start (macOS / Linux)

```bash
# from repo root
cd tauri-app
npm install
# Start the Tauri dev server (this builds the Rust backend and serves the frontend)
npm run start
```

Notes
- The Tauri backend exposes commands `run_files` and `read_output` which spawn the Python `scripts/ml_engine.py` found in the repository.
- The Tauri backend will prefer a Python executable from the `PYTHON_EXECUTABLE` environment variable, then a `.venv` python at the repository root, then `python3` (or `python` on Windows).
- Make sure Python dependencies for the inference engine are installed in the environment used by Tauri (see `scripts/install_inference_dependencies.sh`).

Packaging
- To create distributables run:

```bash
cd tauri-app
npm run build
```

If you want I can further integrate a richer frontend, add an interpreter picker UI, or wire up file-chooser dialogs.
