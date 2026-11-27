#!/usr/bin/env bash
# Usage: run-concurrent.sh <roomy dir> <out dir> <head> <base> <diag> <reps>
set -uo pipefail
roomy=$1 out=$2 head=$3 base=$4 diag=$5 reps=${6:-5}
py=${PY:-python3}
mkdir -p "$out" "$roomy"
for rep in $(seq 1 "$reps"); do
  for exporter in base head; do
    bin=$head; [ "$exporter" = base ] && bin=$base
    "$py" .github/cli-disk/concurrent.py --recorder "$diag" --exporter "$bin" --validator "$head" --dir "$roomy" --out "$out" --tag conc-$exporter-$rep 2>&1 | tee -a "$out/concurrent.log"
  done
done
grep '^CONCURRENT ' "$out/concurrent.log" > "$out/concurrent-summary.txt" || true
