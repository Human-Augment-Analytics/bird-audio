# Design Spec: Linux CI/CD Integration

This document outlines the design for adding Linux builds (specifically Debian `.deb` and `AppImage` packages) to the CI/CD desktop build pipeline.

## Goal
Enable automatic compilation and packaging of the Bird Audio Analyzer Tauri desktop application for Linux environments. The workflow will generate both `.deb` installers and standalone `.AppImage` executables on every release build or push to targeted branches.

## Proposed Changes

### 1. Update GitHub Actions Workflow Configuration
We will modify the existing `.github/workflows/build-desktop.yml` workflow file.

#### A. Expand Build Matrix
We will add `ubuntu-22.04` to the build matrix to ensure optimal compatibility with target Linux distributions (using an older `glibc` library).

```yaml
          - platform: ubuntu-22.04
            artifact-name: Linux-packages
            path: |
              target/release/bundle/deb/*.deb
              target/release/bundle/appimage/*.AppImage
```

#### B. Install System Dependencies
Tauri Linux builds require specific system libraries to compile webview-related features. We will add a system package installation step that runs exclusively on the Linux runner before compiling.

```yaml
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
```

## Verification Plan
1. **GitHub Actions Syntax Validation**: Verify the workflow file syntax using action linters or local checkups.
2. **Local Compilation Check**: Verify that the Tauri build configuration compiles successfully on macOS.
