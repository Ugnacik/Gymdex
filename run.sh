#!/usr/bin/env bash
set -euo pipefail

cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

echo "Open http://127.0.0.1:8080 in your browser."
echo "Press Ctrl+C here to stop Gymdex."
exec python3 -m gymdex.server --port 8080
