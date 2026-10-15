#!/usr/bin/env bash
# Runs the engine verification suites, locally or in CI.
#
#   scripts/verify/run.sh [fast|full] [options] [-- extra nextest args]
#
#   --suites a,b           only these suites (scripts/verify/suites.json);
#                          default: every suite of the tier on this platform
#   --case GLOB            only cases matching GLOB (CAP_VERIFY_CASE)
#   --list                 print the plan and exit
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
extra=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    fast|full) tier="$1" ;;
    --suites) suites="$2"; shift ;;
    --case) export CAP_VERIFY_CASE="$2"; shift ;;
    --list) mode=list ;;
    --no-run) mode=build ;;
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

echo "engine verify: $tier tier on $platform: $suite_names"
if [[ "$mode" == list ]]; then
  echo "cargo: ${cargo_args[*]}"
  echo "filter: $filter"
  exit 0
fi

have_nextest=0
if command -v cargo-nextest >/dev/null 2>&1 || cargo nextest --version >/dev/null 2>&1; then
  have_nextest=1
fi

if [[ "$mode" == archive || "$mode" == from-archive ]] && [[ $have_nextest == 0 ]]; then
  echo "--archive and --from-archive need cargo-nextest (cargo install cargo-nextest --locked)" >&2
  exit 2
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
  run=(cargo nextest run --profile "$nextest_profile" --no-fail-fast)
  if [[ "$mode" == from-archive ]]; then
    # Running from an archive needs no cargo (or toolchain install).
    if command -v cargo-nextest >/dev/null; then
      run=(cargo-nextest nextest run --profile "$nextest_profile" --no-fail-fast)
    fi
    run+=(--archive-file "$archive" --workspace-remap "$root")
  else
    run+=(--cargo-profile "$profile" "${cargo_args[@]}")
  fi
  shard=()
  [[ -n "$partition" ]] && shard=(--partition "$partition")
  "${run[@]}" ${shard[@]+"${shard[@]}"} -E "$filter" ${extra[@]+"${extra[@]}"} || status=$?
  # No retries: a test that fails is rerun once only to label it flaky in the
  # summary. The run still fails.
  junit="${CARGO_TARGET_DIR:-$root/target}/nextest/$nextest_profile/junit.xml"
  if [[ $status != 0 && -n "${CAP_VERIFY_FLAKY_FILE:-}" && -f "$junit" ]]; then
    cp "$junit" "$CAP_VERIFY_REPORT_DIR/junit.xml"
    : >"$CAP_VERIFY_FLAKY_FILE"
    while IFS=$'\t' read -r binary name; do
      [[ -z "$binary" ]] && continue
      echo "rerunning $binary $name once to check for flakiness"
      if CAP_VERIFY_REPORT_DIR="$CAP_VERIFY_REPORT_DIR.rerun" "${run[@]}" -E "binary_id($binary) and test(=$name)"; then
        echo "$binary $name" >>"$CAP_VERIFY_FLAKY_FILE"
      fi
    done < <("$py" -c 'import sys, xml.etree.ElementTree as ET
for c in ET.parse(sys.argv[1]).getroot().iter("testcase"):
    if c.find("failure") is not None or c.find("error") is not None:
        print(c.get("classname"), c.get("name"), sep="\t")' "$CAP_VERIFY_REPORT_DIR/junit.xml" | head -n 5)
  fi
else
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
