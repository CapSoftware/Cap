"""Print `thread apply all bt` for Linux verify crash cores.

usage: linux-core-stacks.py CORES_DIR DEST_DIR

Cores are untrusted input, so the executable path gdb reads out of a core is
never trusted on its own: it must resolve (realpath) to a regular file under
the Cap checkout ($GITHUB_WORKSPACE, else the repo containing this script),
e.g. target/<profile>/deps/* or target/ci-verify/*. Cores must be named
core.<pid> (the CI core_pattern) and live directly in CORES_DIR. Anything
else is skipped with a note written to DEST_DIR/<core>.txt.

Self-check: python3 scripts/verify/linux-core-stacks.py --self-test
"""

import os
import pathlib
import re
import subprocess
import sys

CORE_NAME = re.compile(r"core\.[0-9]+")
EXE_LINE = re.compile(r"^\s*exe = '(/[^'\n]+)'$", re.MULTILINE)


def gdb(*args):
    return subprocess.run(
        [
            "gdb",
            "--nx",
            "--nh",
            "--batch",
            "-iex",
            "set auto-load safe-path /nonexistent",
            "-iex",
            "set auto-load off",
            "-iex",
            "set debuginfod enabled off",
            *args,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
        check=False,
    ).stdout


def workspace_root():
    root = os.environ.get("GITHUB_WORKSPACE") or str(pathlib.Path(__file__).resolve().parents[2])
    return pathlib.Path(os.path.realpath(root))


def is_under(path, root):
    return path == root or root in path.parents


def valid_core(core, cores_dir):
    """Return a reason string if `core` must be skipped, else None."""
    if not CORE_NAME.fullmatch(core.name):
        return f"name {core.name!r} does not match core.<pid>"
    real = pathlib.Path(os.path.realpath(core))
    if real.parent != cores_dir:
        return f"{core} resolves to {real}, outside {cores_dir}"
    if not real.is_file():
        return f"{real} is not a regular file"
    return None


def resolve_executable(raw, root):
    """Return (path, None) for an allowed executable, else (None, reason)."""
    if not raw.startswith("/"):
        return None, f"executable {raw!r} is not an absolute path"
    real = pathlib.Path(os.path.realpath(raw))
    if not is_under(real, root):
        return None, f"executable {raw!r} resolves to {real}, outside the Cap checkout {root}"
    if not real.is_file():
        return None, f"executable {real} is not a regular file"
    return real, None


def stack_for(core, root):
    details = gdb("--core", str(core), "-ex", "info proc exe")
    match = EXE_LINE.search(details)
    if match is None:
        return f"skipped: no executable path in core\n\n{details}"
    executable, reason = resolve_executable(match.group(1), root)
    if executable is None:
        return f"skipped: {reason}\n"
    return gdb(str(executable), "--core", str(core), "-ex", "thread apply all bt 40")


def main():
    cores_dir = pathlib.Path(os.path.realpath(sys.argv[1]))
    destination = pathlib.Path(sys.argv[2])
    root = workspace_root()
    if not cores_dir.is_dir():
        return
    for core in sorted(cores_dir.iterdir()):
        if not core.name.startswith("core."):
            continue
        reason = valid_core(core, cores_dir)
        stack = f"skipped: {reason}\n" if reason else stack_for(core, root)
        if reason or stack.startswith("skipped:"):
            print(f"{core.name}: {stack.splitlines()[0]}")
        destination.mkdir(parents=True, exist_ok=True)
        (destination / f"{core.name}.txt").write_text(stack)
        print(f"::group::{core.name}")
        print(stack)
        print("::endgroup::")


def self_test():
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        tmp = pathlib.Path(os.path.realpath(tmp))
        root = tmp / "ws"
        deps = root / "target" / "ci-verify" / "deps"
        deps.mkdir(parents=True)
        binary = deps / "cap_test-abc"
        binary.write_text("")
        outside = tmp / "evil"
        outside.write_text("")
        (deps / "escape").symlink_to(outside)
        cores = tmp / "cores"
        cores.mkdir()
        (cores / "core.123").write_text("")
        (cores / "core.x1").write_text("")
        (cores / "core.456").symlink_to(outside)

        assert resolve_executable(str(binary), root) == (binary, None)
        assert resolve_executable(str(outside), root)[0] is None
        assert resolve_executable(str(deps / "escape"), root)[0] is None
        assert resolve_executable(str(deps / ".." / ".." / ".." / ".." / "evil"), root)[0] is None
        assert resolve_executable("target/ci-verify/deps/cap_test-abc", root)[0] is None
        assert resolve_executable(str(deps), root)[0] is None
        assert resolve_executable("/usr/bin/true", root)[0] is None
        assert valid_core(cores / "core.123", cores) is None
        assert valid_core(cores / "core.x1", cores) is not None
        assert valid_core(cores / "core.456", cores) is not None
        assert EXE_LINE.search("exe = 'relative'") is None
        assert EXE_LINE.search("exe = '/a/b'\n").group(1) == "/a/b"
    print("self-test ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        main()
