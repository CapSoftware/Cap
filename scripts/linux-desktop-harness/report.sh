#!/usr/bin/env bash
# Summarise one harness run directory: results, harness actions, Cap's own
# lifecycle and error lines.
out=$1
echo "## results ($out)"
cat "$out/result.txt" 2>/dev/null
echo "## actions"
cat "$out/actions.log" 2>/dev/null
echo "## cap"
sed 's/\x1b\[[0-9;]*m//g' "$out/cap.log" 2>/dev/null \
  | grep -E 'cap_gpui::(app_windows|hotkeys|session|recording|target_overlay|single_instance)|ERROR|WARN cap_|panick' \
  | grep -v 'zbus::proxy' | cut -c1-240 | head -${REPORT_LINES:-40}
