Bird Audio Electron App

Prerequisites:
- Node 18+ and npm
- Python 3.8+ and Python dependencies from the project (see pyproject.toml)

Quick start (macOS / Linux):

```bash
cd electron
npm install
npm run start
```

On Windows use `python` if needed and run `npm run start` from PowerShell or cmd.

Notes:
- The Electron main process spawns `scripts/ml_engine.py` using `python3` (or `python` on Windows). Ensure the Python environment has the required ML packages (torch, ultralytics, librosa, etc.).
- Results and intermediate cache files are stored under Electron's `app.getPath('userData')/runs` directory.
