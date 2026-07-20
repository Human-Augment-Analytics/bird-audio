# Linux CI/CD Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Linux build integration (producing `.deb` and `.AppImage` packages) to the GitHub Actions desktop build pipeline.

**Architecture:** Extend the existing matrix in the GitHub Actions workflow with an `ubuntu-22.04` platform runner, install system dependencies needed for Tauri on Linux, and upload both the `.deb` and `.AppImage` bundles under a single artifact category (`Linux-packages`).

**Tech Stack:** GitHub Actions, Tauri CLI, Ubuntu Linux.

## Global Constraints

- Must target `ubuntu-22.04` to optimize glibc compatibility across distributions.
- Install the required webview libraries (`libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libappindicator3-dev`, `librsvg2-dev`, `patchelf`) prior to the Tauri build step on Linux.

---

### Task 1: Update Build Desktop Workflow Matrix and Installer Packages

**Files:**
- Modify: `.github/workflows/build-desktop.yml`

**Interfaces:**
- Consumes: Existing macOS and Windows matrix entries in `.github/workflows/build-desktop.yml`.
- Produces: A new `ubuntu-22.04` matrix item and a conditional dependency setup step.

- [ ] **Step 1: Modify build-desktop.yml to add Linux runner to the matrix and install system dependencies**
Add the `ubuntu-22.04` platform configuration under `matrix.include` and include the system package setup script conditional on `matrix.platform == 'ubuntu-22.04'`.

Replace the content of `.github/workflows/build-desktop.yml` with:
```yaml
name: Build Desktop Application

on:
  push:
    branches:
      - main
      - feature/desktop-ci-cd

jobs:
  build-tauri:
    permissions:
      contents: write
    strategy:
      fail-fast: false
      matrix:
        include:
          - platform: macos-latest
            artifact-name: macOS-dmg
            path: target/release/bundle/dmg/*.dmg
          - platform: windows-latest
            artifact-name: Windows-exe
            path: target/release/bundle/nsis/*.exe
          - platform: ubuntu-22.04
            artifact-name: Linux-packages
            path: |
              target/release/bundle/deb/*.deb
              target/release/bundle/appimage/*.AppImage
    runs-on: ${{ matrix.platform }}
    steps:
      - name: Checkout repository
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - name: Install dependencies
        run: npm ci

      - name: Install system dependencies (Linux only)
        if: matrix.platform == 'ubuntu-22.04'
        run: |
          sudo apt-get update
          sudo apt-get install -y \
            libwebkit2gtk-4.1-dev \
            libgtk-3-dev \
            libappindicator3-dev \
            librsvg2-dev \
            patchelf

      - name: Setup Rust toolchain
        uses: dtolnay/rust-toolchain@stable

      - name: Rust Cache
        uses: swatinem/rust-cache@v2
        with:
          workspaces: 'src-tauri -> target'

      - name: Build Tauri app
        uses: tauri-apps/tauri-action@v0
        id: tauri
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        with:
          tagName: v__VERSION__
          releaseName: 'App v__VERSION__'
          releaseBody: 'Automatic build from CI/CD pipeline'
          releaseDraft: true
          prerelease: false

      - name: Upload Build Artifacts
        uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact-name }}
          path: ${{ matrix.path }}
```

- [ ] **Step 2: Verify YAML syntax**
Run python syntax parsing check on the YAML file.
Run: `uv run python -c "import yaml; yaml.safe_load(open('.github/workflows/build-desktop.yml')); print('YAML syntax is valid')"`
Expected: Output containing `YAML syntax is valid`.

- [ ] **Step 3: Commit**
Run:
```bash
git add .github/workflows/build-desktop.yml
git commit -m "ci: add Linux (ubuntu-22.04) runner and package installers to workflow matrix"
```
