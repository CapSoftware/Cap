#!/usr/bin/env bash
# Usage: run-lock.sh <group: frozen|plain> <dir> <out> <head> <base>
set -uo pipefail
group=$1 dir=$2 out=$3 head=$4 base=$5
py=${PY:-python3}
mkdir -p "$out" "$dir"
lp() { "$py" .github/reclock/lockproof.py --dir "$dir" --out "$out" "$@" 2>&1 | tee -a "$out/lock.log"; }
if [ "$group" = frozen ]; then
  for rep in 1 2 3; do
    "$py" .github/reclock/frozen.py --recorder "$base" --exporter "$base" --validator "$base" --dir "$dir" --out "$out" --tag frozen-base-$rep 2>&1 | tee -a "$out/lock.log"
    "$py" .github/reclock/frozen.py --recorder "$head" --exporter "$head" --validator "$head" --dir "$dir" --out "$out" --tag frozen-head-$rep 2>&1 | tee -a "$out/lock.log"
  done
  for rep in 1 2 3 4 5; do
    lp --cap "$base" --case crash --mode studio --tag crash-base-$rep
    lp --cap "$head" --case crash --mode studio --tag crash-head-$rep
  done
else
  for rep in 1 2 3 4 5; do
    for mode in studio instant; do
      if [ $((rep % 2)) -eq 1 ]; then first=$base fa=base second=$head sa=head; else first=$head fa=head second=$base sa=base; fi
      lp --cap "$first" --case plain --mode $mode --tag plain-$mode-$fa-$rep
      lp --cap "$second" --case plain --mode $mode --tag plain-$mode-$sa-$rep
    done
  done
  for rep in 1 2; do
    for mode in studio instant; do
      lp --cap "$base" --case duration --mode $mode --tag duration-$mode-base-$rep
      lp --cap "$head" --case duration --mode $mode --tag duration-$mode-head-$rep
    done
  done
fi
grep -h '^FROZEN \|^LOCKPROOF ' "$out/lock.log" > "$out/summary.txt" || true
