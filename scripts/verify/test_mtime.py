import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("mtime.py").resolve()
MANIFEST = "target/ci-verify/verify-src-manifest.txt"


class BuildCacheManifestTests(unittest.TestCase):
    """Each CI run restores the shared build cache, builds only the crates its
    suites need, and saves the cache for the next run. A run must never reuse
    a cached build of a crate whose sources changed after that build."""

    def test_a_crate_another_run_did_not_rebuild_is_rebuilt_when_needed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.workspace_with_feature(root)
            self.write(root / "a" / "src" / "lib.rs", "pub fn base() -> u32 { 1 }\n")
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target" / "ci-verify"))
            self.run_command(root, env, "git", "init", "--quiet")
            self.run_command(root, env, "cargo", "generate-lockfile", "--offline")

            # A run that builds both crates and saves the cache.
            self.ci_run(root, env, ["b", "c"])

            # The next saving run gets a new library function but only needs
            # `b`, so the build of `a` with feature `x` stays from before.
            self.write(root / "a" / "src" / "lib.rs", "pub fn base() -> u32 { 1 }\npub fn added() -> u32 { 2 }\n")
            self.ci_run(root, env, ["b"])

            # A later run needs `c`, which now calls the new function.
            self.write(root / "c" / "src" / "lib.rs", "pub fn c() -> u32 { a::added() }\n")
            self.ci_run(root, env, ["c"])

    def test_a_build_script_another_run_did_not_rebuild_reruns_when_needed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.workspace_with_feature(root)
            self.write(root / "a" / "build.rs", "fn main() {}\n")
            self.write(root / "a" / "src" / "lib.rs", "#[cfg(added)]\npub fn added() -> u32 { 2 }\npub fn base() -> u32 { 1 }\n")
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target" / "ci-verify"))
            self.run_command(root, env, "git", "init", "--quiet")
            self.run_command(root, env, "cargo", "generate-lockfile", "--offline")
            self.ci_run(root, env, ["b", "c"])

            self.write(root / "a" / "build.rs", 'fn main() { println!("cargo:rustc-cfg=added"); }\n')
            self.ci_run(root, env, ["b"])

            self.write(root / "c" / "src" / "lib.rs", "pub fn c() -> u32 { a::added() }\n")
            self.ci_run(root, env, ["c"])

    def test_a_build_script_input_another_run_did_not_reread_is_reread_when_needed(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.workspace_with_feature(root)
            self.write(
                root / "a" / "build.rs",
                'fn main() {\n'
                '    println!("cargo:rerun-if-changed=native/flags.txt");\n'
                '    if std::fs::read_to_string("native/flags.txt").unwrap().contains("added") {\n'
                '        println!("cargo:rustc-cfg=added");\n'
                "    }\n"
                "}\n",
            )
            self.write(root / "a" / "native" / "flags.txt", "\n")
            self.write(root / "a" / "src" / "lib.rs", "#[cfg(added)]\npub fn added() -> u32 { 2 }\npub fn base() -> u32 { 1 }\n")
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target" / "ci-verify"))
            self.run_command(root, env, "git", "init", "--quiet")
            self.run_command(root, env, "cargo", "generate-lockfile", "--offline")
            self.ci_run(root, env, ["b", "c"])

            self.write(root / "a" / "native" / "flags.txt", "added\n")
            self.ci_run(root, env, ["b"])

            self.write(root / "c" / "src" / "lib.rs", "pub fn c() -> u32 { a::added() }\n")
            self.ci_run(root, env, ["c"])

    def workspace_with_feature(self, root):
        self.write(root / ".gitignore", "target\n")
        self.write(root / "Cargo.toml", '[workspace]\nmembers = ["a", "b", "c"]\nresolver = "2"\n')
        self.write(
            root / "a" / "Cargo.toml",
            '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n\n[features]\nx = []\n',
        )
        for name, dependency in [("b", 'a = { path = "../a" }'), ("c", 'a = { path = "../a", features = ["x"] }')]:
            self.write(
                root / name / "Cargo.toml",
                f'[package]\nname = "{name}"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n{dependency}\n',
            )
        self.write(root / "b" / "src" / "lib.rs", "pub fn b() -> u32 { a::base() }\n")
        self.write(root / "c" / "src" / "lib.rs", "pub fn c() -> u32 { a::base() }\n")

    def test_unchanged_crates_stay_cached(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            self.write(root / "Cargo.toml", '[workspace]\nmembers = ["a", "b"]\nresolver = "2"\n')
            self.write(root / "a" / "Cargo.toml", '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n')
            self.write(
                root / "b" / "Cargo.toml",
                '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\na = { path = "../a" }\n',
            )
            self.write(root / "a" / "src" / "lib.rs", "pub fn base() -> u32 { 1 }\n")
            self.write(root / "b" / "src" / "lib.rs", "pub fn b() -> u32 { a::base() }\n")
            self.write(root / ".gitignore", "target\n")
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target" / "ci-verify"))
            self.run_command(root, env, "git", "init", "--quiet")
            self.run_command(root, env, "cargo", "generate-lockfile", "--offline")

            self.ci_run(root, env, ["b"])
            self.write(root / "b" / "src" / "lib.rs", "pub fn b() -> u32 { a::base() + 1 }\n")
            output = self.ci_run(root, env, ["b"])
            self.assertIn("Compiling b ", output)
            self.assertNotIn("Compiling a ", output)

    def ci_run(self, root, env, packages):
        self.run_command(root, env, "git", "add", "-A")
        # A checkout gives every file the current time.
        for path in root.rglob("*"):
            if path.is_file() and ".git" not in path.parts and "target" not in path.parts:
                os.utime(path, None)
        self.run_command(root, env, sys.executable, str(SCRIPT), "apply", MANIFEST)
        arguments = ["cargo", "build", "--offline", "--color", "never"]
        for package in packages:
            arguments += ["-p", package]
        output = self.run_command(root, env, *arguments)
        self.run_command(root, env, sys.executable, str(SCRIPT), "record", MANIFEST)
        return output

    @staticmethod
    def write(path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def run_command(self, root, env, *arguments):
        result = subprocess.run(arguments, cwd=root, env=env, capture_output=True, text=True)
        self.assertEqual(
            result.returncode,
            0,
            f"{' '.join(arguments)} failed:\n{result.stdout}\n{result.stderr}",
        )
        return result.stdout + result.stderr


if __name__ == "__main__":
    unittest.main()
