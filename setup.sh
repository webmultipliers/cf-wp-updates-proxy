#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -eq 0 ]]; then
  echo "setup.sh is a CLI launcher."
  echo "Use: ./setup.sh <namespace> <command> [options]"
  echo "Run: ./setup.sh --help"
  exit 1
fi

exec "${SCRIPT_DIR}/bin/proxy-cli.sh" "$@"
