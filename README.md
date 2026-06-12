# Bird Audio Analysis Pipeline

This project provides an automated pipeline for the detection and classification of bird vocalizations, specifically optimized for the Hume's Leaf Warbler (*Phylloscopus humei*).

## Pipeline Overview

The pipeline processes raw audio data through a multi-stage machine learning workflow to identify and label specific bird calls.

### 1. Detection & Localization
The system first scans audio streams to detect potential vocalizations.
- **Model**: `buzz_localizer.onnx`
- **Function**: Identifies time-frequency regions (bounding boxes) within a spectrogram that likely contain bird activity.

### 2. Classification
Detected events are passed to a secondary classifier to determine the species or call type.
- **Model**: `classifier.onnx`
- **Function**: Distinguishes between Hume's Leaf Warbler calls and other environmental noise or species.

### 3. Consolidation & Post-Processing
Overlapping or fragmented detections are merged and filtered to produce a clean set of annotated events.
- **Logic**: Implemented in `src/lib/consolidation.ts`.
- **Metrics**: Evaluation of pipeline performance is handled via `src/lib/evaluation.ts`.

## Validation & Evaluation

The pipeline includes a fixture-based validation harness to ensure accuracy against ground-truth labels.

- **Ground Truth**: Hand-labeled bounding boxes stored in `test-data/labels/`.
- **Evaluation**: Run the evaluation script to compare predictions against labels:
  ```sh
  npm run eval -- <labels.json> <predictions.json>
  ```

## Technical Stack

- **Inference Engine**: ONNX Runtime (Web/Node.js)
- **Audio Processing**: Web Audio API and custom DSP logic in `src/lib/audioProcessor.ts`
- **Testing**: Node.js test runner for unit tests and pipeline validation.

## Large File Processing (Tauri)

For large audio recordings (1GB+) that exceed browser memory limits, the project uses **Tauri** to run the pipeline natively.

- **Native UI**: The `NativeProcessor.tsx` component provides a local file picker.
- **Python Backend**: Tauri triggers `scripts/ml_engine.py` directly, leveraging PyTorch and the `.pt` models for high-performance inference.
- **Workflow**:
  1. Open the application via Tauri (`npm run tauri dev`).
  2. Use the "Large File Native Processor" in the sidebar.
  3. Select a local WAV file.
  4. View real-time logs and progress as the native pipeline scans the file.
