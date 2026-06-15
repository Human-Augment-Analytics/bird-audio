# Lab Manager UX Improvements — Design

**Date:** 2026-06-14
**Status:** Brainstormed; Pending user review

## 1. Purpose
The current batch runner prototype is highly functional but exposes too much technical complexity (Python commands, CUDA devices, Greek parameter names). This design abstracts those details for a **lab manager with an ecology background**, focusing on their primary goals: verifying the system is ready, processing recordings, and seeing results.

## 2. Terminology & Branding
Technical terms are replaced with lab-oriented language:
- `θ_A` (theta_a) → **Detection Sensitivity**
- `θ_B` (theta_b) → **Quality Filter**
- `Device` → **Processing Engine** (e.g., "Graphics Card")
- `Worker Command / CWD` → **System Internals** (Hidden by default)
- `Throughput` → **Processing Speed**
- `ETA` → **Estimated Completion Time**

## 3. The "Smart Dashboard" Layout

### 3.1 Setup View (Initial State)
- **System Health Panel (Top):** A prominent card showing the status of prerequisites.
  - `Environment: [Ready | Not Setup]`
  - `Models: [Found | Missing]`
  - `Processing Engine: [Auto-detected device]`
  - **"Prepare System" Button:** Only visible/active if health checks fail. Performs auto-setup (Task 4.1).
- **Recording Source Selection:**
  - Folder picker + manual input.
  - On selection, UI reports: *"Checking folder... 4,120 files found."*
- **Primary Configuration:**
  - **Detection Sensitivity (Slider/Input):** 0.0 to 1.0 (Default 0.0). Higher = find more potential buzzes.
  - **Quality Filter (Slider/Input):** 0.0 to 1.0 (Default 0.53). Higher = stricter completeness check.
- **Advanced Settings (Collapsed):**
  - Hidden under a "System Internals" toggle.
  - Contains: Worker Command, Working Directory, Concurrency, Timeout, Max Attempts.
- **Start Button:** Primary action.

### 3.2 Run View (Progress State)
- **Status Summary Card:**
  - Progress bar + Pct.
  - *"Processed 1,200 of 4,120 files."*
  - *"Estimated Completion: 3:15 PM (approx. 40 mins remaining)."*
- **The Buzz Counter:**
  - **Total Events Found:** (e.g., 10,245)
  - **High-Quality Buzzes:** (Count of 'complete' events)
- **Simplified Table:**
  - Focus on filename and event counts.
  - Errors shown as a summary count: *"12 files skipped due to format issues. [View Errors]"*.
- **Controls:** Large, clear **Pause / Resume** and **Cancel** buttons.

## 4. Technical Logic

### 4.1 System Health & Auto-Setup
- **Verification Command:** Rust will invoke the worker with a `--check` or similar flag to verify Python, Torch, and Models.
- **Prepare System:** If missing, Rust will attempt to:
  1. Run `uv sync` or `pip install` for the environment.
  2. (Optional/Future) Download models from a configured URL if missing.
- **Auto-Device:** Rust will automatically pick the best device (CUDA > MPS > CPU) and pass it to the worker, displaying a user-friendly name in the UI.

### 4.2 Enhanced Progress Calculation
- Use a moving average of processing time to provide a stable, human-readable ETA (clock time, not just seconds remaining).

## 5. Out of Scope
- Re-implementing the core pipeline (this is a UI/Orchestration layer update).
- Deep ecological modeling within the app.

## 6. Success Criteria
- A non-technical lab manager can open the app and start a batch run in < 3 clicks.
- No technical error messages (stack traces) are shown in the primary UI.
- The system handles its own prerequisites via the "Prepare System" button.
