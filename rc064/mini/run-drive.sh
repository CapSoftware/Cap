#!/bin/zsh
# run-drive.sh <out dir> <flows> [env assignments...]: runs drive.py as a child of
# CapRigLauncher (inherits its Camera/Mic/Screen grants). Started by go.sh.
out=$1; flows=$2; shift 2
for kv in "$@"; do export "$kv"; done
export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
G=$HOME/gate064
mkdir -p $out
cd $G
$G/venv/bin/python -u $G/drive.py $G/apps $G/harness $out $flows > $out/drive.log 2>&1
echo "rc $?" >> $out/drive.log
touch $out/DONE
