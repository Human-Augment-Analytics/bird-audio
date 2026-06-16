#!/usr/bin/env bash
set -euo pipefail

# Installs all Python dependencies required by
# the ML inference engine (`scripts/ml_engine.py`).
#
# By default this script will install packages into the current Python
# environment's user site (via `--user`). To create and use a virtualenv,
# pass `--venv <path>`.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
REQ_FILE="${SCRIPT_DIR}/requirements-inference.txt"
VENV_DIR=""  # empty = do not create venv by default
PYTHON_BIN="python3"
TORCH_MODE="cpu"

print_help() {
  cat <<'EOF'
Usage: ./scripts/install_inference_dependencies.sh [options]

Options:
  --python <bin>   Python executable to use (default: python3)
  --venv <path>    Virtualenv path to create/use (default: ./.venv)
  --cpu            Install CPU/default PyTorch wheels (default)
  --cuda           Install CUDA 12.1 PyTorch wheels
  -h, --help       Show this help

Examples:
  ./scripts/install_inference_dependencies.sh
  ./scripts/install_inference_dependencies.sh --python python3.11 --venv .venv
  ./scripts/install_inference_dependencies.sh --cuda
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --python)
      PYTHON_BIN="$2"
      shift 2
      ;;
      --venv)
        VENV_DIR="$2"
        shift 2
        ;;
    --cpu)
      TORCH_MODE="cpu"
      shift
      ;;
    --cuda)
      TORCH_MODE="cuda"
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      print_help
      exit 1
      ;;
  esac
done

if [[ ! -f "${REQ_FILE}" ]]; then
  echo "requirements file not found: ${REQ_FILE}" >&2
  exit 1
fi

if ! command -v "${PYTHON_BIN}" >/dev/null 2>&1; then
  echo "Python executable not found: ${PYTHON_BIN}" >&2
  exit 1
fi


echo "Using Python: ${PYTHON_BIN}"
if [[ -n "${VENV_DIR}" ]]; then
  echo "Creating/using virtualenv: ${VENV_DIR}"
  "${PYTHON_BIN}" -m venv "${VENV_DIR}"
  # shellcheck disable=SC1091
  source "${VENV_DIR}/bin/activate"
  PIP_INSTALL=(python -m pip install --upgrade pip setuptools wheel)
else
  echo "No virtualenv requested; installing into current environment's user site (--user)."
  PIP_INSTALL=("${PYTHON_BIN}" -m pip install --upgrade --user pip setuptools wheel)
fi

"${PIP_INSTALL[@]}"

if [[ "${TORCH_MODE}" == "cuda" ]]; then
  echo "Installing CUDA-enabled PyTorch wheels (cu121)..."
  if [[ -n "${VENV_DIR}" ]]; then
    python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
  else
    "${PYTHON_BIN}" -m pip install --user torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121
  fi
else
  echo "Installing default PyTorch wheels (CPU/macOS/MPS depending on platform)..."
  if [[ -n "${VENV_DIR}" ]]; then
    python -m pip install torch torchvision torchaudio
  else
    "${PYTHON_BIN}" -m pip install --user torch torchvision torchaudio
  fi
fi

if [[ -n "${VENV_DIR}" ]]; then
  python -m pip install -r "${REQ_FILE}"
else
  "${PYTHON_BIN}" -m pip install --user -r "${REQ_FILE}"
fi

echo
echo "Dependency installation complete."
if [[ -n "${VENV_DIR}" ]]; then
  echo "Activate your environment with: source ${VENV_DIR}/bin/activate"
else
  echo "Packages installed to the user site for ${PYTHON_BIN}."
fi
