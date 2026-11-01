import pathlib
import re
import subprocess
import sys


def gdb(*args):
    return subprocess.run(
        ["gdb", "--nx", "--batch", "-iex", "set auto-load safe-path /nonexistent", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        timeout=120,
        check=False,
    ).stdout


def main():
    cores = pathlib.Path(sys.argv[1])
    destination = pathlib.Path(sys.argv[2])
    for core in sorted(cores.glob("core.*")):
        details = gdb("--core", str(core), "-ex", "info proc exe")
        executable = re.search(r"^\s*exe = '(.+)'$", details, re.MULTILINE)
        if executable is None:
            stack = details
        else:
            stack = gdb(
                executable.group(1),
                "--core",
                str(core),
                "-ex",
                "thread apply all bt 40",
            )
        destination.mkdir(parents=True, exist_ok=True)
        (destination / f"{core.name}.txt").write_text(stack)
        print(f"::group::{core.name}")
        print(stack)
        print("::endgroup::")


if __name__ == "__main__":
    main()
