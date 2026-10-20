#!/usr/bin/env bash
# Rewrites the strict expectations files so that a run passes exactly.
#
#   scripts/verify/bless.sh [fast|full] [run.sh options]   run here, then bless
#   scripts/verify/bless.sh --run <github run id>          bless from the report
#                                                          artifacts of a CI run
#                                                          (every platform)
#   scripts/verify/bless.sh --reports <dir>...             bless from report dirs
#
# Each platform only changes its own entries; reasons and links of existing
# entries are kept and new failures get a "TODO:" reason that must be
# replaced before CI accepts the file. Review the diff: a blessed failure is a
# known bug the suite will keep checking.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"

reports=()
case "${1:-}" in
  --run)
    [[ -n "${2:-}" ]] || { echo "usage: $0 --run <run id>" >&2; exit 2; }
    dir="$(mktemp -d)"
    gh run download "$2" --pattern 'verify-report-*' --dir "$dir"
    reports=("$dir")
    ;;
  --reports)
    shift
    reports=("$@")
    ;;
  *)
    tier=fast
    [[ "${1:-}" == fast || "${1:-}" == full ]] && tier="$1"
    case "$(uname -s)" in
      Darwin) platform=macos ;;
      Linux) platform=linux ;;
      *) platform=windows ;;
    esac
    export CAP_VERIFY_REPORT_DIR="${CAP_VERIFY_REPORT_DIR:-$root/target/verify-report/$platform-$tier}"
    scripts/verify/run.sh "$@" || true
    reports=("$CAP_VERIFY_REPORT_DIR")
    ;;
esac

cargo run -q -p cap-verify-expect -- bless "${reports[@]}"
git --no-pager diff --stat -- '*expectations*.toml'
