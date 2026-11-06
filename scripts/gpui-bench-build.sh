#!/usr/bin/env bash
# Builds Cap's GPUI frame benchmarks (apps/desktop-gpui/gpui-benches) against
# a prepared zed checkout and copies the benchmark executable to <out-dir>.
#
#   scripts/gpui-bench-build.sh <zed-dir> <out-dir>
#
# The bench crate is copied into <zed-dir>/crates/gpui_cap_benches and added to
# that workspace, so it compiles against exactly the patched gpui in <zed-dir>
# and Zed's own lockfile. Set CARGO_TARGET_DIR to share dependency builds
# between checkouts.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
zed_dir="$(cd "$1" && pwd)"
out_dir="$2"
bench_src="$repo_root/apps/desktop-gpui/gpui-benches"
bench_dst="$zed_dir/crates/gpui_cap_benches"

mkdir -p "$bench_dst" "$out_dir"
cp -R "$bench_src/." "$bench_dst/"

python_bin="$(command -v python3 || command -v python)"
"$python_bin" - "$zed_dir/Cargo.toml" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
member = '    "crates/gpui_cap_benches",\n'
if member not in text:
    anchor = '    "crates/gpui_windows",\n'
    if anchor not in text:
        sys.exit("error: could not find the gpui_windows workspace member to anchor on")
    text = text.replace(anchor, anchor + member, 1)
    open(path, "w", encoding="utf-8", newline="\n").write(text)
PY

cd "$zed_dir"
messages="$out_dir/cargo-messages.json"
cargo +1.95.0 bench -p gpui_cap_benches --bench frame --no-run --message-format json > "$messages"
executable="$("$python_bin" - "$messages" <<'PY'
import json, sys
found = None
for line in open(sys.argv[1], encoding="utf-8"):
    try:
        message = json.loads(line)
    except ValueError:
        continue
    if (
        message.get("reason") == "compiler-artifact"
        and message.get("target", {}).get("name") == "frame"
        and message.get("executable")
    ):
        found = message["executable"]
if not found:
    sys.exit("error: cargo reported no executable for the frame benchmark")
print(found)
PY
)"
case "$executable" in
	*.exe) cp "$executable" "$out_dir/frame.exe" ;;
	*) cp "$executable" "$out_dir/frame" ;;
esac
echo "Built $(basename "$executable") from $zed_dir into $out_dir"
