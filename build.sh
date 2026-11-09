#!/usr/bin/env bash
# Build complet du paquet : bundle JS (bun/webpack) puis wheel (uv/hatchling).
#
# `uv build --wheel` et non `uv build` : sans --wheel, hatch construit sdist PUIS
# wheel ; l'sdist est écrit en premier, donc un échec du hook laisserait un
# dist/*.tar.gz orphelin.
set -euo pipefail
cd "$(dirname "$0")"

( cd js && bun install && bun run build )

DAG_GANTT_JS_DIR=js/dist uv build --wheel
ls -l dist/
