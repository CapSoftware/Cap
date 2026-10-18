#!/usr/bin/env python3
"""Builds the engine suite's export, seek and playback test binaries of one
worktree with the perf-verify profile and copies them out, so a second build
in the same target directory cannot replace them.

    perf-build.py WORKTREE OUT_DIR   -> OUT_DIR/binaries.json
"""
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

TARGETS = ["export", "seek", "playback"]
# Release optimisation without link-time optimisation or single-unit codegen,
# so two builds per pull request stay affordable. Passed as --config so a base
# commit without this profile builds it too.
PROFILE = [
    "--config", 'profile.perf-verify.inherits="release"',
    "--config", "profile.perf-verify.lto=false",
    "--config", "profile.perf-verify.codegen-units=16",
    "--config", "profile.perf-verify.incremental=false",
    "--config", "profile.perf-verify.debug=0",
]


def main():
    worktree, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    out.mkdir(parents=True, exist_ok=True)
    metadata = json.loads(subprocess.check_output(
        ["cargo", "metadata", "--format-version", "1", "--locked"],
        cwd=worktree,
        text=True,
    ))
    # Another CI cache may have normalized source mtimes, hiding changes from
    # Cargo. Rebuild local crates while retaining registry and git dependencies.
    clean = ["cargo", *PROFILE, "clean", "--profile", "perf-verify"]
    for package in metadata["packages"]:
        if package["source"] is None:
            clean += ["-p", package["id"]]
    subprocess.run(clean, cwd=worktree, check=True)
    command = ["cargo", *PROFILE, "test", "--locked", "-p", "cap-verify", "--profile", "perf-verify", "--no-run", "--message-format", "json"]
    for target in TARGETS:
        command += ["--test", target]
    result = subprocess.run(command, cwd=worktree, stdout=subprocess.PIPE, text=True)
    if result.returncode:
        print(result.stdout, end="", flush=True)
        result.check_returncode()
    binaries = {}
    for line in result.stdout.splitlines():
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        if row.get("reason") == "compiler-artifact" and row.get("executable") and row["target"]["name"] in TARGETS:
            source = Path(row["executable"])
            deps = out / "deps"
            deps.mkdir(exist_ok=True)
            dest = deps / source.name
            shutil.copy2(source, dest)
            binaries[row["target"]["name"]] = str(dest)
            # macOS binaries load FFmpeg from @executable_path/../Frameworks.
            # scripts/setup.js puts the framework in target/Frameworks; local
            # builds may also have one per profile.
            target_dir = source.parent.parent.parent
            link = out / "Frameworks"
            candidates = [target_dir / source.parent.parent.name / "Frameworks", target_dir / "Frameworks"]
            candidates += [target_dir / profile / "Frameworks" for profile in ("release", "debug")]
            for frameworks in candidates:
                if frameworks.exists() and not link.exists():
                    link.symlink_to(frameworks, target_is_directory=True)
                    break
    missing = [t for t in TARGETS if t not in binaries]
    if missing:
        sys.exit(f"missing test binaries: {missing}")
    if sys.platform == "darwin" and not (out / "Frameworks").exists():
        sys.exit("no FFmpeg Frameworks directory next to the target dir: run scripts/setup.js")
    (out / "binaries.json").write_text(json.dumps({"worktree": str(worktree), "binaries": binaries}, indent=2))
    print(json.dumps(binaries, indent=2))


if __name__ == "__main__":
    main()
