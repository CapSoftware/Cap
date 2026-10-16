#!/usr/bin/env python3
"""Runs the guard sentinels listed in scripts/verify/guards.toml.

  guards.py [--profile PROFILE] [--summary FILE]

A sentinel that fails, or that no longer exists, is reported as a WARNING
(a ::warning annotation and a "Guard changed: needs deep review" section in
the summary file), never as a failure: the guards are equivalent mutants, so
a change to them needs review rather than a red build. Exit status is 0
unless cargo itself cannot run.
"""

import argparse
import os
import subprocess
import sys
import tomllib

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--profile", default=os.environ.get("CAP_VERIFY_CARGO_PROFILE", "dev"))
    parser.add_argument("--summary", default=os.environ.get("GITHUB_STEP_SUMMARY"))
    args = parser.parse_args()
    with open(os.path.join(ROOT, "scripts", "verify", "guards.toml"), "rb") as f:
        guards = tomllib.load(f).get("guard", [])
    changed = []
    for g in guards:
        cmd = ["cargo", "test", "--profile", args.profile, "-p", g["package"], g["target"], "--", "--exact", g["test"]]
        if os.environ.get("CAP_VERIFY_LOCKED") == "1":
            cmd.insert(2, "--locked")
        print(f"guard {g['id']}: {' '.join(cmd)}", flush=True)
        result = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True)
        output = result.stdout + result.stderr
        if result.returncode == 0 and "running 1 test" in output:
            print(f"guard {g['id']}: sentinel holds")
            continue
        if result.returncode == 0:
            reason = f"sentinel {g['test']} did not run (renamed or removed?)"
        elif "test result: FAILED" in output:
            reason = f"sentinel {g['test']} fails"
        else:
            sys.stdout.write(output[-4000:])
            sys.exit(f"guard {g['id']}: cargo failed before running the sentinel")
        print(output[-3000:])
        print(f"::warning title=Guard changed: {g['id']} ({g['area']})::{reason}. {g['prevents']}")
        changed.append((g, reason))
    if changed and args.summary:
        lines = ["## Guard changed: needs deep review", ""]
        lines.append("A sentinel of a guard whose removal changes no checked output now fails. This is a warning, not a failure: review the change to the guard closely.")
        lines.append("")
        for g, reason in changed:
            lines.append(f"- **{g['id']}** ({g['area']}; {', '.join(g['symbols'])}): {reason}. {g['why']} Prevents: {g['prevents']} Repro: `cargo test -p {g['package']} {g['target']} -- --exact {g['test']}`")
        with open(args.summary, "a") as f:
            f.write("\n".join(lines) + "\n\n")
    print(f"guards: {len(guards) - len(changed)} of {len(guards)} sentinels hold")


if __name__ == "__main__":
    main()
