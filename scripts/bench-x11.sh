#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v xvfb-run >/dev/null; then
	echo "xvfb-run not found (install xvfb)" >&2
	exit 1
fi

cargo build --release -p cap-recording --example x11-capture-benchmark

exec xvfb-run -a -s "-screen 0 3840x2160x24" \
	cargo run --release -q -p cap-recording --example x11-capture-benchmark -- "$@"
