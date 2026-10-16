#!/usr/bin/env python3
"""Plans engine verification runs from scripts/verify/suites.json.

  plan.py select --tier fast --platform linux [--suites a,b] [--local]
      Prints four lines for run.sh: the suite names, the cargo target
      selection, the nextest filter expression and the case globs to skip.

  plan.py changes --tier fast [--files FILE | --all] [--metadata FILE]
      Maps changed paths to suites through the workspace dependency graph
      (`cargo metadata`) and prints GitHub step outputs: run, reason,
      suites, matrix.
  plan.py recording [--files FILE | --all]
      run=, reason= for the real-capture workflow: whether a change reaches
      the recorder's or the stimulus's dependency closure or the harness.
  plan.py risk --files F [--summary FILE] [--output FILE]
      changed files -> high-risk regions and guards (scripts/verify/guards.toml):
      escalate=, regions=, guards= lines plus ::warning annotations.

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


def load_guards():
    import tomllib

    with open(os.path.join(ROOT, "scripts", "verify", "guards.toml"), "rb") as f:
        return tomllib.load(f)


# Engine crates: a pull request that changes any of them runs the FULL tier
# (with Blacksmith runners there is no queue to save).
ENGINE_CRATES = [
    "crates/rendering/**",
    "crates/editor/**",
    "crates/export/**",
    "crates/recording/**",
    "crates/enc-*/**",
    "crates/audio/**",
    "crates/video-decode/**",
    "crates/project/**",
    "crates/scap-*/**",
    "crates/camera*/**",
    "crates/media/**",
    "crates/media-info/**",
    "crates/frame-converter/**",
    "crates/gpu-converters/**",
    "crates/cursor-capture/**",
    "crates/timestamp/**",
    "crates/cap-muxer/**",
]


def engine_files(files):
    return sorted({p for p in files for pattern in ENGINE_CRATES if match(p, pattern)})


def risk(files, guards=None):
    """(regions touched, guards whose files are touched) for changed files."""
    guards = guards or load_guards()
    regions = []
    for region in guards.get("region", []):
        hits = sorted({p for p in files for pattern in region["paths"] if match(p, pattern)})
        if hits:
            regions.append((region["name"], hits))
    touched = [
        g for g in guards.get("guard", []) if any(p in g["files"] for p in files)
    ]
    return regions, touched


def risk_report(regions, touched):
    """Job-summary markdown and annotation lines for a risky diff."""
    if not regions and not touched:
        return "", []
    md = ["## Needs deep review", ""]
    notes = []
    if regions:
        md.append("This change touches high-risk engine code. A pull request that does runs the FULL tier, with real capture on both macOS versions:")
        md.append("")
        for name, hits in regions:
            md.append(f"- **{name}**: " + ", ".join(f"`{h}`" for h in hits[:6]) + (" ..." if len(hits) > 6 else ""))
            notes.append(f"::warning title=Needs deep review ({name})::{', '.join(hits[:6])}")
        md.append("")
    if touched:
        md.append("### Guard changed: needs deep review")
        md.append("")
        md.append("These guards protect users, but removing them changes no output the suites check (equivalent mutants), so only review can catch a regression:")
        md.append("")
        for g in touched:
            md.append(f"- **{g['id']}** ({g['area']}; {', '.join(g['symbols'])}): {g['why']} Prevents: {g['prevents']}")
            notes.append(f"::warning title=Guard changed: {g['id']} ({g['area']})::{g['prevents']}")
        md.append("")
    return "\n".join(md), notes


def load_config():
    with open(os.path.join(ROOT, "scripts", "verify", "suites.json")) as f:
        return json.load(f)


def match(path, pattern):
    if pattern.endswith("/**"):
        prefix = pattern[:-2]
        if any(c in prefix for c in "*?["):
            return fnmatch.fnmatchcase(path, prefix + "*")
        return path.startswith(prefix)
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


def cmd_env(args):
    """Shell `export` lines for the env of the selected suites (suites.json
    `env`: {"KEY": "value"} or {"KEY": {"<platform>": "value"}}) and the
    platform's unsupported-case allowlist. Variables already set in the
    environment win."""
    import shlex
    config = load_config()
    names = [n for n in (args.suites or "").split(",") if n]
    allow = ",".join(config.get("unsupported", {}).get(args.platform, {}).keys())
    if allow and "CAP_VERIFY_UNSUPPORTED_ALLOW" not in os.environ:
        print(f"export CAP_VERIFY_UNSUPPORTED_ALLOW={shlex.quote(allow)}")
    for suite in select(config, args.tier, args.platform, names or None, args.local):
        for key, value in suite.get("env", {}).items():
            if isinstance(value, dict):
                value = value.get(args.platform)
            if value is None or key in os.environ:
                continue
            print(f"export {key}={shlex.quote(str(value))}")


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
        if path.startswith("apps/desktop-gpui/"):
            return all_names, f"{path} changes the standalone GPUI application"
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


def extra_runners(config, names, tier, files):
    """Additional platform entries (suites.json `extra_runners`): the same
    platform's suites on another machine class, for a path the main runner
    cannot cover (macOS export on the VideoToolbox hardware encoder, which
    Blacksmith VMs lack). Included for every changed path that matches the
    entry's `paths`, and always when `files` is None (a full run)."""
    out = []
    for name, entry in config.get("extra_runners", {}).items():
        suites = [
            s["name"] for s in config["suites"]
            if s["name"] in names and s["name"] in entry["suites"] and entry["os"] in s["platforms"][tier]
        ]
        if not suites:
            continue
        if files is not None and not any(match(f, p) for f in files for p in entry["paths"]):
            continue
        shards = entry["shards"][tier] if isinstance(entry["shards"], dict) else entry["shards"]
        out.append({
            "platform": name,
            "os": entry["os"],
            "runner": os.environ.get(f"ENGINE_VERIFY_{name.upper().replace('-', '_')}_RUNNER", "").strip() or entry["runner"],
            "target": entry["target"],
            "shards": shards,
            "shard_list": json.dumps(list(range(1, shards + 1))),
            "archive": entry.get("archive", False),
            "suites": ",".join(suites),
        })
    return out


def matrix(config, names, tier, files=None):
    include = []
    for platform in PLATFORMS:
        suites = [s["name"] for s in config["suites"] if s["name"] in names and platform in s["platforms"][tier]]
        if not suites:
            continue
        runner = dict(config["runners"][platform])
        # One switch per platform without a code change: the repository
        # variable ENGINE_VERIFY_<PLATFORM>_RUNNER (passed in by
        # engine-verify.yml) overrides suites.json, e.g. macos-15 to go back
        # to GitHub-hosted runners.
        override = os.environ.get(f"ENGINE_VERIFY_{platform.upper()}_RUNNER", "").strip()
        if override:
            runner["runner"] = override
        if isinstance(runner["shards"], dict):
            runner["shards"] = runner["shards"][tier]
        include.append({
            "platform": platform,
            "os": platform,
            "runner": runner["runner"],
            "target": runner["target"],
            "shards": runner["shards"],
            "shard_list": json.dumps(list(range(1, runner["shards"] + 1))),
            "archive": runner.get("archive", False),
            "suites": ",".join(suites),
        })
    include += extra_runners(config, names, tier, files)
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
    files = None
    if args.all:
        names, reason = [s["name"] for s in config["suites"]], "full run"
    else:
        with open(args.files) as f:
            files = [line.strip() for line in f if line.strip()]
        if len(files) >= args.max_files:
            names, reason = [s["name"] for s in config["suites"]], f"{len(files)} changed files (list may be truncated)"
            files = None
        else:
            names, reason = affected(config, files, load_metadata(args.metadata), args.tier)
    if args.suites:
        wanted = [n for n in args.suites.split(",") if n]
        unknown = set(wanted) - {s["name"] for s in config["suites"]}
        if unknown:
            sys.exit(f"unknown suites: {', '.join(sorted(unknown))}")
        names = [n for n in names if n in wanted]
        reason += f" (limited to {args.suites})"
    m = matrix(config, names, args.tier, files)
    lines = {
        "run": "true" if m["include"] else "false",
        "reason": reason.replace("\n", " "),
        "suites": ",".join(names),
        "matrix": json.dumps(m, separators=(",", ":")),
    }
    for key, value in lines.items():
        print(f"{key}={value}")


# Real capture (crates/verify/tests/recording.rs): the recorder and the
# stimulus, their whole dependency closure, and the harness itself.
RECORDING = {
    "roots": ["cap-recording", "cap-verify-stimulus"],
    "own": [
        "crates/verify/tests/recording.rs",
        "crates/verify/src/**",
        "crates/verify/Cargo.toml",
        "crates/verify/expectations.toml",
        "crates/verify-expect/**",
        "crates/verify-stimulus/**",
        ".github/workflows/verify-recording.yml",
    ],
}


def recording_affected(config, files, metadata):
    """(run, reason) for the real-capture workflow."""
    for path in files:
        for pattern in config["always"] + RECORDING["own"]:
            if match(path, pattern):
                return True, f"{path} affects real capture"
    dirs, deps = workspace_graph(metadata)
    reach = set().union(*(closure(r, deps) for r in RECORDING["roots"]))
    for path in files:
        # Other suites' test files share the cap-verify package but not the
        # recording test binary.
        if path.startswith("crates/verify/tests/"):
            continue
        package = owning_package(path, dirs)
        if package in reach:
            return True, f"{path} ({package}) is in the recorder's dependency closure"
    return False, "no recording code changed"


def cmd_recording(args):
    config = load_config()
    if args.all:
        run, reason = True, "full run"
    else:
        with open(args.files) as f:
            files = [line.strip() for line in f if line.strip()]
        if len(files) >= args.max_files:
            run, reason = True, f"{len(files)} changed files (list may be truncated)"
        else:
            run, reason = recording_affected(config, files, load_metadata(args.metadata))
    print(f"run={'true' if run else 'false'}")
    print(f"reason={reason}")


def cmd_risk(args):
    with open(args.files) as f:
        files = [line.strip() for line in f if line.strip()]
    regions, touched = risk(files)
    md, notes = risk_report(regions, touched)
    if args.summary and md:
        with open(args.summary, "a") as f:
            f.write(md + "\n")
    for note in notes:
        print(note)
    engine = engine_files(files)
    if engine:
        print(f"::notice title=Engine crates changed::FULL tier for {', '.join(engine[:6])}{' ...' if len(engine) > 6 else ''}")
    outputs = [
        f"escalate={'true' if regions or touched else 'false'}",
        f"engine={'true' if engine else 'false'}",
        f"regions={','.join(name for name, _ in regions)}",
        f"guards={','.join(g['id'] for g in touched)}",
    ]
    if args.output:
        with open(args.output, "a") as f:
            f.write("\n".join(outputs) + "\n")
    else:
        print("\n".join(outputs))


def cmd_test(_args):
    config = load_config()
    metadata = load_metadata(None)
    cases = [
        (["apps/web/app/page.tsx", "README.md"], []),
        (["crates/verify/tests/seek.rs"], ["seek"]),
        (["crates/verify/tests/seek.rs", "crates/verify/tests/export.rs"], ["export", "seek"]),
        (["crates/verify/src/oracle.rs"], [s["name"] for s in config["suites"] if "cap-verify" in s["roots"]]),
        (["crates/verify/src/audio_model.rs"], ["audio"]),
        (["crates/rendering/src/decoder/ffmpeg.rs"], [s["name"] for s in config["suites"]]),
        (["crates/video-decode/src/ffmpeg.rs"], [s["name"] for s in config["suites"]]),
        (["Cargo.lock"], [s["name"] for s in config["suites"]]),
        (["scripts/verify/run.sh"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/src/main.rs"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/src/editor.rs"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/src/recording.rs"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/src/upload/verify_tests.rs"], [s["name"] for s in config["suites"]]),
        (["apps/desktop-gpui/Cargo.toml"], [s["name"] for s in config["suites"]]),
    ]
    failed = 0
    for files, expected in cases:
        names, reason = affected(config, files, metadata, "fast")
        ok = sorted(names) == sorted(expected)
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} {files} -> {names} ({reason})")
    guards = load_guards()
    for g in guards.get("guard", []):
        if not any(match(f, pattern) for f in g["files"] for r in guards["region"] for pattern in r["paths"]):
            failed += 1
            print(f"BAD guard {g['id']}: its files lie outside every high-risk region")
    for files, expected in [
        (["crates/enc-ffmpeg/src/base.rs"], (["encoder timestamps"], ["E02"])),
        (["crates/editor/src/audio.rs", "README.md"], (["audio mixing and Studio Sound"], ["A09"])),
        (["apps/desktop-gpui/src/upload/queue.rs"], (["upload retry"], [])),
        (["crates/verify/src/oracle.rs", "apps/web/app/page.tsx"], ([], [])),
    ]:
        regions, touched = risk(files, guards)
        got = ([n for n, _ in regions], [g["id"] for g in touched])
        ok = got == expected
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} risk {files} -> {got}")
    for files, expected in [
        (["crates/rendering/src/lib.rs"], True),
        (["crates/enc-ffmpeg/src/lib.rs"], True),
        (["crates/camera-ffmpeg/src/lib.rs"], True),
        (["apps/desktop-gpui/src/main.rs", "crates/verify/src/oracle.rs"], False),
    ]:
        ok = bool(engine_files(files)) == expected
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} engine {files} -> {bool(engine_files(files))}")
    for files, expected in [
        (["crates/frame-converter/src/lib.rs"], True),
        (["crates/recording/src/studio_recording.rs"], True),
        (["crates/verify/tests/recording.rs"], True),
        (["vendor/wgpu-hal/src/lib.rs"], True),
        (["Cargo.toml"], True),
        (["crates/verify/tests/export.rs", "apps/web/app/page.tsx"], False),
    ]:
        got = recording_affected(config, files, metadata)[0]
        ok = got == expected
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} recording {files} -> {got}")
    names = [s["name"] for s in config["suites"]]
    for files, expected in [
        (["crates/enc-ffmpeg/src/video/h264.rs"], True),
        (["crates/export/src/mp4.rs"], True),
        (["crates/rendering/src/decoder/ffmpeg.rs"], False),
        (["crates/editor/src/playback.rs"], False),
        (None, True),
    ]:
        got = any(e["platform"] == "macos-vt" for e in matrix(config, names, "fast", files)["include"])
        ok = got == expected
        failed += not ok
        print(f"{'ok ' if ok else 'BAD'} macos-vt {files} -> {got}")
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
    p = sub.add_parser("env")
    p.add_argument("--tier", choices=["fast", "full"], required=True)
    p.add_argument("--platform", choices=PLATFORMS, required=True)
    p.add_argument("--suites")
    p.add_argument("--local", action="store_true")
    p.set_defaults(func=cmd_env)
    p = sub.add_parser("changes")
    p.add_argument("--tier", choices=["fast", "full"], required=True)
    p.add_argument("--files")
    p.add_argument("--all", action="store_true")
    p.add_argument("--metadata")
    p.add_argument("--max-files", type=int, default=3000)
    p.add_argument("--suites")
    p.set_defaults(func=cmd_changes)
    p = sub.add_parser("recording")
    p.add_argument("--files")
    p.add_argument("--all", action="store_true")
    p.add_argument("--metadata")
    p.add_argument("--max-files", type=int, default=3000)
    p.set_defaults(func=cmd_recording)
    p = sub.add_parser("risk")
    p.add_argument("--files", required=True)
    p.add_argument("--summary", help="append the markdown report to this file")
    p.add_argument("--output", help="append the escalate/regions/guards lines to this file (GITHUB_OUTPUT)")
    p.set_defaults(func=cmd_risk)
    p = sub.add_parser("test")
    p.set_defaults(func=cmd_test)
    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
