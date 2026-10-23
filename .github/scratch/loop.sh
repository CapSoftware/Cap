#!/bin/bash
# usage: loop.sh <label> <iterations> <pressure:0|1> <filter mode: two|all>
label=$1; n=$2; pressure=$3; mode=$4
fails=0; events=0; fail_with_event=0
threads=(1 2 0)
for i in $(seq 1 "$n"); do
  t=${threads[$((i % 3))]}
  targs=()
  [ "$t" != 0 ] && targs=(--test-threads="$t")
  if [ "$mode" = two ]; then
    filt=(--exact audio::tests::a_replay_resumes_a_parked_render audio::tests::a_stale_render_is_released_once_the_next_render_finishes)
  else
    filt=(audio::tests::)
  fi
  pp=""
  if [ "$pressure" = 1 ]; then
    ( for k in 1 2 3 4 5 6; do sudo memory_pressure -S -l warn -s 1 >/dev/null 2>&1; sleep 0.3; done ) &
    pp=$!
  fi
  cargo test --locked -q -p cap-editor --lib -- "${filt[@]}" "${targs[@]}" > out.txt 2>&1; rc=$?
  [ -n "$pp" ] && wait "$pp"
  ev=$(grep -c "OS MEMORY PRESSURE EVENT" out.txt)
  events=$((events + ev))
  if [ $rc -ne 0 ]; then
    fails=$((fails + 1)); [ "$ev" -gt 0 ] && fail_with_event=$((fail_with_event + 1))
    echo "iteration $i threads=$t FAILED (events=$ev)"; grep -E "panicked|FAILED|EVENT" out.txt | head -8
  fi
done
echo "RESULT $label: iterations=$n failures=$fails os_pressure_events=$events failures_with_event=$fail_with_event" | tee -a "$GITHUB_STEP_SUMMARY"
