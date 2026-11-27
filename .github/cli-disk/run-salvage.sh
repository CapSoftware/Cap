#!/usr/bin/env bash
# Usage: run-salvage.sh <1 GiB volume> <roomy dir> <out dir> <head> <base> <diag>
set -uo pipefail
vol=$1 roomy=$2 out=$3 head=$4 base=$5 diag=$6
py=${PY:-python3}
mkdir -p "$out" "$roomy"
d() { "$py" .github/cli-disk/drive.py --out "$out" --export-args="${EXPORT_ARGS:-}" "$@" 2>&1 | tee -a "$out/drive.log"; }
inj="CAP_RECORDING_FAIL_PIPELINE_AFTER_MS=12000"
br="--video-bitrate 28"
"$head" --version
for ref in head base; do
  bin=$head; [ "$ref" = base ] && bin=$base
  d --volume "$roomy" --cap "$bin" --ref $ref --mode studio --tag inj-studio-$ref --duration 30 --env "$inj" --post "$br"
  d --volume "$roomy" --cap "$bin" --ref $ref --mode instant --tag inj-instant-$ref --duration 30 --env "$inj"
done
d --volume "$roomy" --cap "$base" --ref base --mode studio --tag inj-base-rechead --duration 30 --env "$inj" --post "$br" --recover-cap "$head"
d --volume "$roomy" --cap "$base" --ref base --mode studio --tag inj-base-recbase --duration 30 --env "$inj" --post "$br" --recover-cap "$base"
d --volume "$roomy" --cap "$base" --ref base --mode studio --tag inj-base-corrupt-rechead --duration 30 --env "$inj" --post "$br" --recover-cap "$head" --corrupt
d --volume "$roomy" --cap "$head" --ref head --mode studio --tag inj-head-detach --duration 120 --env "$inj" --post "$br" --detach
d --volume "$vol" --cap "$base" --ref base --mode studio --tag full250-base-rechead --start-free-mib 250 --duration 90 --post "$br" --recover-cap "$head"
d --volume "$vol" --cap "$base" --ref base --mode studio --tag full250-base-recbase --start-free-mib 250 --duration 90 --post "$br" --recover-cap "$base"
d --volume "$vol" --cap "$base" --ref base --mode studio --tag full250-base-movehead --start-free-mib 250 --duration 90 --post "$br" --recover-cap "$head" --recover-copy-to "$roomy"
for order in "head base" "base head"; do
  for ref in $order; do
    bin=$head; [ "$ref" = base ] && bin=$base
    d --volume "$roomy" --cap "$bin" --ref $ref --mode studio --tag ctl-$ref-$RANDOM --duration 20 --post "$br"
  done
done
for exporter in base head; do
  bin=$head; [ "$exporter" = base ] && bin=$base
  "$py" .github/cli-disk/concurrent.py --recorder "$diag" --exporter "$bin" --validator "$head" --dir "$roomy" --out "$out" --tag concurrent-export-$exporter 2>&1 | tee -a "$out/drive.log"
done
grep -E '^(SUMMARY|CONCURRENT) ' "$out/drive.log" > "$out/summary.txt" || true
