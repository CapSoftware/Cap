#!/usr/bin/env bash
# Usage: run-frozen.sh <roomy dir> <out dir> <head> <base>
set -uo pipefail
roomy=$1 out=$2 head=$3 base=$4
py=${PY:-python3}
mkdir -p "$out" "$roomy"
for rep in 1 2; do
  "$py" .github/cli-disk/frozen.py --recorder "$base" --exporter "$base" --validator "$base" --dir "$roomy" --out "$out" --tag frozen-base-base-$rep 2>&1 | tee -a "$out/frozen.log"
  "$py" .github/cli-disk/frozen.py --recorder "$head" --exporter "$head" --validator "$head" --dir "$roomy" --out "$out" --tag frozen-head-head-$rep 2>&1 | tee -a "$out/frozen.log"
done
grep '^FROZEN ' "$out/frozen.log" > "$out/frozen-summary.txt" || true
