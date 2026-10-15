#!/usr/bin/env bash
# Scratch: runs targeted gap tests unmutated, then under each mutation.
# Usage: gaps.sh "ID:suite:test ..." OUTDIR   (ID "-" = unmutated)
set -u
out="$2"
mkdir -p "$out"
for spec in $1; do
  IFS=: read -r id suite test <<< "$spec"
  [ "$id" != "-" ] && python3 scripts/verify/mutation/apply.py apply "$id" > /dev/null
  log="$out/$id-$suite-$test.log"
  export CAP_VERIFY_REPORT_DIR="$out/report-$id-$suite-$test"
  mkdir -p "$CAP_VERIFY_REPORT_DIR"
  cargo test --profile ci-verify -p cap-verify --test "$suite" -- --exact "$test" --nocapture > "$log" 2>&1
  code=$?
  [ "$id" != "-" ] && python3 scripts/verify/mutation/apply.py revert "$id"
  echo "=== $id $suite::$test exit $code"
  cat "$CAP_VERIFY_REPORT_DIR"/*.jsonl 2>/dev/null | python3 -c '
import sys, json
for l in sys.stdin:
    r = json.loads(l)
    print("   ", r.get("outcome"), r.get("case"), sorted((r.get("failures") or {}).keys()), (r.get("summary") or "")[:400])
'
  grep -E "^error(\[|:)|could not compile" "$log" | head -5
done
