#!/usr/bin/env bash
# Fail unless every scenario directory given recorded, stopped and finished a
# recording and brought its windows back, with no blocked lease, unconfirmed
# restore, preflight failure, pipeline failure or panic, and Cap still running
# at the end.
# Usage: check-results.sh <out-dir>...
status=0
for out in "$@"; do
  result=$out/result.txt
  name=$(basename "$out")
  if [[ ! -s $result ]]; then
    echo "::error::$name produced no result"
    status=1
    continue
  fi
  value() { sed -n "s/^$1=//p" "$result" | tail -1; }
  problems=()
  [[ $(value attempt1_started) == yes ]] || problems+=("recording never started")
  [[ $(value attempt1_finished) == yes ]] || problems+=("recording never finished")
  [[ $(value attempt1_restored) == yes ]] || problems+=("recording UI never came back")
  [[ $(value cap_alive) == yes ]] || problems+=("Cap exited")
  for key in blocked restoration_unconfirmed preflight_failed pipeline_failed panics; do
    [[ $(value "$key") == 0 ]] || problems+=("$key=$(value "$key")")
  done
  if ((${#problems[@]})); then
    echo "::error::$name: ${problems[*]}"
    status=1
  else
    echo "$name: recorded, stopped and finished ($(value attempt1_control) control)"
  fi
done
exit $status
