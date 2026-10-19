#!/usr/bin/env bash
# Runs the engine verification suites, locally or in CI.
#
#   scripts/verify/run.sh [fast|full] [options] [-- extra nextest args]
#
#   --suites a,b           only these suites (scripts/verify/suites.json);
#                          default: every suite of the tier on this platform
#   --case GLOB            only cases matching GLOB (CAP_VERIFY_CASE)
#   --list                 print the plan and exit
#   --check-rerun-selection  check that a test name read back from Python
#                          (as the retry and flaky reruns do) selects exactly
#                          that test (CRLF on Windows)
#   --no-run               build only
#   --archive FILE         build a nextest archive (CI build job)
#   --from-archive FILE    run from a nextest archive (CI shard job)
#   --partition hash:M/N   run one shard
#
# Uses cargo-nextest when installed (one process per test, parallel), else
# runs `cargo test` per suite. Results: one JSON line per case in
# $CAP_VERIFY_REPORT_DIR (default target/verify-report/<platform>-<tier>),
# summarised at the end by scripts/verify/summary.py.
#
# Environment: CAP_VERIFY_CARGO_PROFILE (default dev; CI uses ci-verify),
# CAP_VERIFY_NEXTEST_PROFILE (default default; CI uses ci),
# CAP_VERIFY_FIXTURE_DIR (generated fixtures cache).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

tier=fast
suites=""
mode=run
archive=""
partition=""
prepare_fixtures=0
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    fast|full) tier="$1" ;;
    --suites) suites="$2"; shift ;;
    --case) export CAP_VERIFY_CASE="$2"; shift ;;
    --list) mode=list ;;
    --check-rerun-selection) mode=check-selection ;;
    --no-run) mode=build ;;
    --prepare-fixtures) prepare_fixtures=1 ;;
    --archive) mode=archive; archive="$2"; shift ;;
    --from-archive) mode=from-archive; archive="$2"; shift ;;
    --partition) partition="$2"; shift ;;
    --) shift; extra=("$@"); break ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

case "$(uname -s)" in
  Darwin) platform=macos ;;
  Linux) platform=linux ;;
  MINGW*|MSYS*|CYGWIN*) platform=windows ;;
  *) echo "unsupported platform $(uname -s)" >&2; exit 2 ;;
esac

py="$(command -v python3 || command -v python)"
local_flag=""
[[ -z "${CI:-}" ]] && local_flag=--local
plan="$("$py" scripts/verify/plan.py select --tier "$tier" --platform "$platform" ${suites:+--suites "$suites"} $local_flag)"
suite_names="$(sed -n 1p <<<"$plan")"
read -r -a cargo_args <<<"$(sed -n 2p <<<"$plan")"
filter="$(sed -n 3p <<<"$plan")"
skip="$(sed -n 4p <<<"$plan")"
eval "$("$py" scripts/verify/plan.py env --tier "$tier" --platform "$platform" ${suites:+--suites "$suites"} $local_flag)"
if [[ -n "$skip" ]]; then
  export CAP_VERIFY_SKIP="${CAP_VERIFY_SKIP:+$CAP_VERIFY_SKIP,}$skip"
fi

if [[ -z "$suite_names" ]]; then
  echo "no $tier suites for $platform${suites:+ in $suites}"
  exit 0
fi

# CAP_VERIFY_CARGO_CONFIG: extra `--config KEY=VALUE` overrides, `;` separated
# (profile experiments). CAP_VERIFY_LOCKED=1 adds --locked.
if [[ -n "${CAP_VERIFY_CARGO_CONFIG:-}" ]]; then
  IFS=';' read -r -a overrides <<<"$CAP_VERIFY_CARGO_CONFIG"
  for override in "${overrides[@]}"; do
    [[ -n "$override" ]] && cargo_args+=(--config "$override")
  done
fi
if [[ "${CAP_VERIFY_LOCKED:-}" == 1 ]]; then
  cargo_args+=(--locked)
fi

profile="${CAP_VERIFY_CARGO_PROFILE:-dev}"
nextest_profile="${CAP_VERIFY_NEXTEST_PROFILE:-default}"
export CAP_VERIFY_TIER="$tier"
export CAP_VERIFY_REPORT_DIR="${CAP_VERIFY_REPORT_DIR:-$root/target/verify-report/$platform-$tier}"

echo "engine verify: $tier tier on $platform: $suite_names${CAP_VERIFY_SHARD:+ (case shard $CAP_VERIFY_SHARD)}"
if [[ "$mode" == list ]]; then
  echo "cargo: ${cargo_args[*]}"
  echo "filter: $filter"
  echo "skip: ${CAP_VERIFY_SKIP:-}"
  exit 0
fi

# The crash and chaos suites spawn the out-of-process muxer; build it with
# the same profile so it sits beside the test binaries
# (target/<profile>/cap-muxer).
if [[ ( " ${suite_names//,/ } " == *" crash "* || " ${suite_names//,/ } " == *" chaos "* ) && "$mode" != archive ]]; then
  cargo build --profile "$profile" -p cap-muxer ${CAP_VERIFY_LOCKED:+--locked}
fi

have_nextest=0
if command -v cargo-nextest >/dev/null 2>&1 || cargo nextest --version >/dev/null 2>&1; then
  have_nextest=1
fi

if [[ "$mode" == archive || "$mode" == from-archive ]] && [[ $have_nextest == 0 ]]; then
  echo "--archive and --from-archive need cargo-nextest (cargo install cargo-nextest --locked)" >&2
  exit 2
fi

if [[ "$mode" == check-selection ]]; then
  list=(cargo nextest list --color never --cargo-profile "$profile" "${cargo_args[@]}" --message-format oneline)
  line="$("${list[@]}" -E "$filter" 2>/dev/null | head -n 1)"
  [[ -n "$line" ]] || { echo "::error::no test listed for $filter"; exit 1; }
  selected() { "${list[@]}" -E "binary_id($1) and test(=$2)" 2>/dev/null | grep -c . || true; }
  raw="$("$py" -c 'import sys; print(sys.argv[1], sys.argv[2], sep="\t")' "${line%% *}" "${line#* }")"
  IFS=$'\t' read -r b n <<<"$raw"
  echo "without CR stripping: $(selected "$b" "$n") test(s) selected"
  IFS=$'\t' read -r b n <<<"$(tr -d '\r' <<<"$raw")"
  count="$(selected "$b" "$n")"
  if [[ "$count" != 1 ]]; then
    echo "::error::the rerun filter for '$b' '$n' selects $count tests"
    exit 1
  fi
  echo "rerun selection round trip ok: $b $n"
  exit 0
fi

case "$mode" in
  build)
    if [[ $have_nextest == 1 ]]; then
      exec cargo nextest run --cargo-profile "$profile" "${cargo_args[@]}" --no-run
    fi
    exec cargo test --profile "$profile" "${cargo_args[@]}" --no-run
    ;;
  archive)
    exec cargo nextest archive --cargo-profile "$profile" "${cargo_args[@]}" --archive-file "$archive"
    ;;
esac

if [[ -z "${CI:-}" ]]; then
  rm -rf "$CAP_VERIFY_REPORT_DIR"
fi
mkdir -p "$CAP_VERIFY_REPORT_DIR"

status=0
started=$SECONDS
if [[ $have_nextest == 1 ]]; then
  # --no-tests=fail: a filter that selects nothing (a renamed test, a typo)
  # fails instead of passing.
  run=(cargo nextest run --profile "$nextest_profile" --no-fail-fast --no-tests=fail)
  if [[ "$mode" == from-archive ]]; then
    # Running from an archive needs no cargo (or toolchain install).
    if command -v cargo-nextest >/dev/null; then
      run=(cargo-nextest nextest run --profile "$nextest_profile" --no-fail-fast --no-tests=fail)
    fi
    run+=(--archive-file "$archive" --workspace-remap "$root")
  else
    run+=(--cargo-profile "$profile" "${cargo_args[@]}")
  fi
  if [[ $prepare_fixtures == 1 ]]; then
    "${run[@]}" --run-ignored ignored-only -E 'binary_id(cap-verify::export) and test(=prepare_recorded_fixtures)'
    exit
  fi
  shard=()
  [[ -n "$partition" ]] && shard=(--partition "$partition")
  "${run[@]}" ${shard[@]+"${shard[@]}"} -E "$filter" ${extra[@]+"${extra[@]}"} || status=$?
  junit="${CARGO_TARGET_DIR:-$root/target}/nextest/$nextest_profile/junit.xml"
  # Always kept: the gate checks that every planned test ran (floor.py).
  if [[ -f "$junit" ]]; then cp "$junit" "$CAP_VERIFY_REPORT_DIR/junit.xml"; fi
  # Starvation retry: a test whose only failures are wall-clock classes
  # under a proven machine stall (inconclusive cases, or a timeout with the
  # sentinel's evidence) runs once more with CAP_VERIFY_RETRY=1. The run
  # passes only if every failed test was retryable and every retry passed;
  # a case inconclusive again fails as `environment`. See retry.py.
  if [[ $status != 0 && -f "$CAP_VERIFY_REPORT_DIR/junit.xml" ]]; then
    # Python on Windows ends lines with CRLF: strip the CR, or the last
    # field (and the test name in a filter) carries it.
    retry_plan="$("$py" scripts/verify/retry.py "$CAP_VERIFY_REPORT_DIR/junit.xml" "$CAP_VERIFY_REPORT_DIR" | tr -d '\r')"
    blocking="$(sed -n 's/^blocking\t//p' <<<"$retry_plan")"
    retried=0
    retry_failed=0
    while IFS=$'\t' read -r binary name evidence; do
      [[ -z "$binary" || "$binary" == blocking ]] && continue
      retried=$((retried + 1))
      echo "retrying $binary $name once: $evidence"
      echo "::warning title=Retried after a machine stall::$binary $name: $evidence"
      echo "$binary $name: $evidence" >>"$CAP_VERIFY_REPORT_DIR/retried.txt"
      if ! CAP_VERIFY_RETRY=1 CAP_VERIFY_REPORT_DIR="$CAP_VERIFY_REPORT_DIR/retry" \
        "${run[@]}" -E "binary_id($binary) and test(=$name)"; then
        retry_failed=$((retry_failed + 1))
        echo "$binary $name: failed again on retry" >>"$CAP_VERIFY_REPORT_DIR/retried.txt"
      fi
    done <<<"$retry_plan"
    if [[ $retried -gt 0 && "${blocking:-1}" == 0 && $retry_failed == 0 ]]; then
      echo "every failure was a proven machine stall and passed on retry"
      status=0
    fi
  fi
  # No other retries: any other failed test is rerun once only to label it
  # flaky in the summary. The run still fails.
  if [[ $status != 0 && -n "${CAP_VERIFY_FLAKY_FILE:-}" && -f "$CAP_VERIFY_REPORT_DIR/junit.xml" ]]; then
    : >"$CAP_VERIFY_FLAKY_FILE"
    while IFS=$'\t' read -r binary name; do
      [[ -z "$binary" ]] && continue
      echo "rerunning $binary $name once to check for flakiness"
      rerun=0
      CAP_VERIFY_REPORT_DIR="$CAP_VERIFY_REPORT_DIR.rerun" "${run[@]}" -E "binary_id($binary) and test(=$name)" || rerun=$?
      if [[ $rerun == 0 ]]; then
        echo "$binary $name" >>"$CAP_VERIFY_FLAKY_FILE"
      elif [[ $rerun == 4 ]]; then
        # nextest's NO_TESTS_RUN: the filter is wrong, not the test.
        echo "::error title=Flaky rerun selected no test::$binary $name"
        status=1
      fi
    done < <("$py" -c 'import sys, xml.etree.ElementTree as ET
for c in ET.parse(sys.argv[1]).getroot().iter("testcase"):
    if c.find("failure") is not None or c.find("error") is not None:
        print(c.get("classname"), c.get("name"), sep="\t")' "$CAP_VERIFY_REPORT_DIR/junit.xml" | tr -d '\r' | head -n 5)
  fi
else
  if [[ $prepare_fixtures == 1 ]]; then
    echo "--prepare-fixtures needs cargo-nextest" >&2
    exit 2
  fi
  echo "cargo-nextest not found: running suites one by one with cargo test (cargo install cargo-nextest --locked for parallel runs)"
  for name in $suite_names; do
    plan_one="$("$py" scripts/verify/plan.py select --tier "$tier" --platform "$platform" --suites "$name" --local)"
    read -r -a one_args <<<"$(sed -n 2p <<<"$plan_one")"
    test_name="$("$py" -c 'import json,sys; c=json.load(open("scripts/verify/suites.json")); print(next(s.get("test","") for s in c["suites"] if s["name"]==sys.argv[1]))' "$name")"
    echo "== $name"
    if [[ -n "$test_name" ]]; then
      cargo test --profile "$profile" "${one_args[@]}" -- --exact "$test_name" ${extra[@]+"${extra[@]}"} || status=$?
    else
      cargo test --profile "$profile" "${one_args[@]}" -- ${extra[@]+"${extra[@]}"} || status=$?
    fi
  done
fi

echo
"$py" scripts/verify/summary.py --title "$platform $tier" --text \
  --junit "$CAP_VERIFY_REPORT_DIR/junit.xml" ${CAP_VERIFY_FLAKY_FILE:+--flaky "$CAP_VERIFY_FLAKY_FILE"} \
  "$CAP_VERIFY_REPORT_DIR" || true
echo "engine verify: $tier tier on $platform finished in $((SECONDS - started)) s (exit $status)"
exit $status
