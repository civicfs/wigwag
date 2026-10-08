#!/usr/bin/env bash
# One-step setup: build, install the wigwag CLI globally, then install the Claude and Codex plugins.
# Usage: ./install.sh [--claude-only | --codex-only] [--codex-binary <path>]
set -euo pipefail
cd "$(dirname "$0")"

node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' \
  || { echo "wigwag needs Node >= 24 (found $(node --version))" >&2; exit 1; }

npm ci
npm run build
npm install -g .
wigwag install "$@"
wigwag doctor "$@"
