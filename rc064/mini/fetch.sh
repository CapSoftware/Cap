#!/bin/zsh
# fetch.sh <label> <run id> <os...>: pull a media branch on the MINI (never the
# laptop) and copy back only results.json to res/<label>-<os>/out/<os>/.
cd /Users/richie/capfix/gate064/res
label=$1; run=$2; shift 2
for os in "$@"; do
  b=ci/gate064-app-media-$os-$run-1
  ssh rmini "mkdir -p ~/gate064/media && cd ~/gate064/media && rm -f r.json && curl -fsSL -H \"Authorization: token \$(gh auth token)\" -o r.json https://raw.githubusercontent.com/CapSoftware/Cap/$b/out/$os/results.json && echo ok" >/dev/null 2>&1
  mkdir -p $label-$os/out/$os
  scp -q rmini:gate064/media/r.json $label-$os/out/$os/results.json && echo "got $label-$os"
done
