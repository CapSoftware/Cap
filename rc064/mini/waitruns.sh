#!/bin/zsh
# waitruns.sh <run id>...: returns when every run has completed; prints conclusions.
cd /Users/richie/Documents/github/Cap
for id in "$@"; do
  gh run watch "$id" --interval 120 > /dev/null 2>&1
done
for id in "$@"; do
  gh run view "$id" --json name,headBranch,conclusion --jq "[\"$id\",.headBranch,.name,.conclusion]|@tsv"
done
