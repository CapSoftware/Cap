#!/usr/bin/env python3
"""Plans engine verification runs from scripts/verify/suites.json.

  plan.py select --tier fast --platform linux [--suites a,b] [--local]
      Prints four lines for run.sh: the suite names, the cargo target
      selection, the nextest filter expression and the case globs to skip.

  plan.py changes --tier fast [--files FILE | --all] [--metadata FILE]
      Maps changed paths to suites through the workspace dependency graph
      (`cargo metadata`) and prints GitHub step outputs: run, reason,
      suites, matrix.

  plan.py test
      Self-test of the change mapping.
"""

import argparse
import fnmatch
import json
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
PLATFORMS = ["linux", "macos", "windows"]


def load_config():
    with open(os.path.join(ROOT, "scripts", "verify", "suites.json")) as f:
        return json.load(f)


def match(path, pattern):
    if pattern.endswith("/**"):
        return path.startswith(pattern[:-2])
    return fnmatch.fnmatchcase(path, pattern)


def suite_filter(suite):
    parts = []
    for binary in suite["binaries"]:
        expr = f"binary_id({binary})"
        if suite.get("test"):
            expr = f"({expr} and test(={suite['test']}))"
        parts.append(expr)
    return " or ".join(parts)


def select(config, tier, platform, names=None, local=False):
    # Locally, platform-independent suites (CI runs them on linux only) run
    # on every platform too.
    suites = [
        s for s in config["suites"]
        if platform in s["platforms"][tier] or (local and s["platforms"][tier] == ["linux"])
    ]
    if names:
        unknown = set(names) - {s["name"] for s in config["suites"]}
        if unknown:
            sys.exit(f"unknown suites: {', '.join(sorted(unknown))}")
        suites = [s for s in suites if s["name"] in names]
    return suites


def cargo_args(suites):
    packages, flags = [], []
    for suite in suites:
        args = suite["cargo"]
        i = 0
        while i < len(args):
            if args[i] == "-p":
                if args[i + 1] not in packages:
                    packages.append(args[i + 1])
                i += 2
                continue
            if args[i] == "--test":
                flag = ["--test", args[i + 1]]
                i += 2
            else:
                flag = [args[i]]
                i += 1
            if flag not in flags:
                flags.append(flag)
    out = []
    for package in packages:
        out += ["-p", package]
    for flag in flags:
        out += flag
    return out


def cmd_select(args):
    config = load_config()
    names = [n for n in (args.suites or "").split(",") if n]
    suites = select(config, args.tier, args.platform, names or None, args.local)
    print(" ".join(s["name"] for s in suites))
    print(" ".join(cargo_args(suites)))
    print(" or ".join(f"({suite_filter(s)})" for s in suites))
    skips = []
    for suite in suites:
        for glob in suite.get("skip", {}).get(args.tier, {}).get(args.platform, []):
            if glob not in skips:
                skips.append(glob)
    print(",".join(skips))


def workspace_graph(metadata):
    """Package dirs and reverse dependencies (normal, dev and build)."""
    dirs, deps = {}, {}
    for package in metadata["packages"]:
        name = package["name"]
        dirs[name] = os.path.relpath(os.path.dirname(package["manifest_path"]), metadata["workspace_root"]).replace(os.sep, "/")
        deps[name] = [
            (d["name"], d.get("kind") or "normal")
            for d in package["dependencies"]
            if d.get("path")
        ]
    return dirs, deps


def closure(root, deps):
    """Packages whose code ends up in `root`'s tests: root's normal, dev and
    build dependencies, then normal and build dependencies transitively."""
    seen = {root}
    stack = [(name, kind) for name, kind in deps.get(root, [])]
    while stack:
        name, _kind = stack.pop()
        if name in seen or name not in deps:
            continue
        seen.add(name)
        stack.extend((n, k) for n, k in deps[name] if k != "dev")
    return seen


def owning_package(path, dirs):
    best = None
    for name, d in dirs.items():
        if d == ".":
            continue
        if path == d or path.startswith(d + "/"):
            if best is None or len(d) > len(dirs[best]):
                best = name
    return best


def affected(config, files, metadata, tier):
    """Returns (suite names, reason)."""
    all_names = [s["name"] for s in config["suites"]]
    for path in files:
        for pattern in config["always"]:
            if match(path, pattern):
                return all_names, f"{path} affects every suite"
    dirs, deps = workspace_graph(metadata)
    closures = {s["name"]: set().union(*(closure(r, deps) for r in s["roots"])) for s in config["suites"]}
    owned = {}
    for suite in config["suites"]:
        for pattern in suite["own"]:
            owned.setdefault(pattern, set()).add(suite["name"])
    selected, reasons = set(), []
    for path in files:
        package = owning_package(path, dirs)
        if package is None:
            continue
        owners = set()
        for pattern, names in owned.items():
            if match(path, pattern):
                owners |= names
        hits = owners if owners else {n for n, c in closures.items() if package in c}
        if hits - selected:
            reasons.append(f"{path} ({package}) -> {', '.join(sorted(hits))}")
        selected |= hits
    names = [n for n in all_names if n in selected]
    if not names:
        return [], "no engine code changed"
    return names, "; ".join(reasons[:8]) + (" ..." if len(reasons) > 8 else "")


def matrix(config, names, tier):
    include = []
    for platform in PLATFORMS:
        suites = [s["name"] for s in config["suites"] if s["name"] in names and platform in s["platforms"][tier]]
        if not suites:
            continue
        runner = dict(config["runners"][platform])
        if isinstance(runner["shards"], dict):
            runner["shards"] = runner["shards"][tier]
        include.append({
            "platform": platform,
            "runner": runner["runner"],
            "target": runner["target"],
            "shards": runner["shards"],
            "shard_list": json.dumps(list(range(1, runner["shards"] + 1))),
            "archive": runner.get("archive", False),
            "suites": ",".join(suites),
        })
    return {"include": include}


def load_metadata(path):
    if path:
        with open(path) as f:
            return json.load(f)
    env = dict(os.environ)
    env.setdefault("RUSTUP_TOOLCHAIN", "stable")
    out = subprocess.run(
        ["cargo", "metadata", "--no-deps", "--format-version", "1"],
        cwd=ROOT, env=env, check=True, capture_output=True, text=True,
    ).stdout
    return json.loads(out)


def cmd_changes(args):
    config = load_config()
    if args.all:
        names, reason = [s["name"] for s in config["suites"]], "full run"
    else:
        with open(args.files) as f:
            files = [line.strip() for line in f if line.strip()]
        if len(files) >= args.max_files:
            names, reason = [s["name"] for s in config["suites"]], f"{len(files)} changed files (list may be truncated)"
        else:
            names, reason = affected(config, files, load_metadata(args.metadata), args.tier)
    if args.suites:
        wanted = [n for n in args.suites.split(",") if n]
        unknown = set(wanted) - {s["name"] for s in config["suites"]}
        if unknown:
            sys.exit(f"unknown suites: {', '.join(sorted(unknown))}")
        names = [n for n in names if n in wanted]
        reason += f" (limited to {args.suites})"
    m = matrix(config, names, args.tier)
    lines = {
        "run": "true" if m["include"] else "false",
        "reason": reason.replace("\n", " "),
        "suites": ",".join(names),
        "matrix": json.dumps(m, separators=(",", ":")),
    }
    for key, value in lines.items():
        print(f"{key}={value}")


def cmd_test(_args):
    config = load_config()
    metadata = load_metadata(None)
    cases = [
        (["apps/web/app/page.tsx", "README.md"], []),
        (["crates/verify/tests/seek.rs"], ["seek"]),
        (["crates/verify/tests/seek.rs", "crates/verify/tests/export.rs"], ["export", "seek"]),
        (["crates/verify/src/oracle.rs"], ["verify-self", "export", "playback", "seek", "audio"]),
        (["crates/verify/src/audio_model.rs"], ["audio"]),
        (["crates/rendering/src/decoder/ffmpeg.rs"], [s["name"] for s in config["suites"]]),
        (["crates/video-decode/src/ffmpeg.rs"], [s["name"] for s in config["suites"]]),
        (["Cargo.lock"], [s["name"] for s in config["suites"]]),
        (["scripts/verify/run.sh"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/src/main.rs"], []),
    ]
    failed = 0
    for files, expected in cases:
        names, reason = affected(config, files, metadata, "fast")
        ok = sorted(names) == sorted(expected)
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} {files} -> {names} ({reason})")
    rendering_only = affected(config, ["crates/rendering/src/decoder/model/mod.rs"], metadata, "fast")[0]
    if "decoder-model-ffmpeg" not in rendering_only:
        failed += 1
        print(f"BAD decoder model change -> {rendering_only}")
    sys.exit(1 if failed else 0)


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    p = sub.add_parser("select")
    p.add_argument("--tier", choices=["fast", "full"], required=True)
    p.add_argument("--platform", choices=PLATFORMS, required=True)
    p.add_argument("--suites")
    p.add_argument("--local", action="store_true")
    p.set_defaults(func=cmd_select)
    p = sub.add_parser("changes")
    p.add_argument("--tier", choices=["fast", "full"], required=True)
    p.add_argument("--files")
    p.add_argument("--all", action="store_true")
    p.add_argument("--metadata")
    p.add_argument("--max-files", type=int, default=3000)
    p.add_argument("--suites")
    p.set_defaults(func=cmd_changes)
    p = sub.add_parser("test")
    p.set_defaults(func=cmd_test)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
