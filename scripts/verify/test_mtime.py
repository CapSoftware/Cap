"""Builds a tiny cargo workspace the way the CI cache does and checks that
mtime.py never lets cargo reuse a workspace crate built from other sources."""

import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

MTIME = Path(__file__).with_name("mtime.py").resolve()
MANIFEST = "target/ci-verify/verify-src-manifest.txt"

FILES = {
    "Cargo.toml": '[workspace]\nmembers = ["a", "b", "c"]\nresolver = "2"\n'
    '[profile.ci-verify]\ninherits = "dev"\nincremental = false\n',
    ".gitignore": "/target\n",
    "a/Cargo.toml": '[package]\nname = "a"\nversion = "0.1.0"\nedition = "2021"\n[features]\nx = []\n',
    "a/src/lib.rs": "pub fn old() -> u32 { 1 }\n",
    # b and c need different features of a: two builds of a in one target.
    "b/Cargo.toml": '[package]\nname = "b"\nversion = "0.1.0"\nedition = "2021"\n'
    '[dependencies]\na = { path = "../a", features = ["x"] }\n',
    "b/src/lib.rs": "pub fn f() -> u32 { a::old() }\n",
    "c/Cargo.toml": '[package]\nname = "c"\nversion = "0.1.0"\nedition = "2021"\n'
    '[dependencies]\na = { path = "../a" }\n',
    "c/src/lib.rs": 'pub fn g() -> u32 { a::old() }\npub fn s() -> &\'static str { include_str!("../../shared/data.txt") }\n',
    "c/tests/t.rs": '#[test] fn t() { assert_eq!(c::s().trim(), std::env::var("WANT").unwrap()); }\n',
    "shared/data.txt": "one\n",
}


class CacheTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("CARGO_TARGET")}
        self.env["CARGO_INCREMENTAL"] = "0"
        for path, text in FILES.items():
            self.write(path, text)
        self.git("init", "-q")
        self.commit("init")

    def tearDown(self):
        self.tmp.cleanup()

    def write(self, path, text):
        (self.root / path).parent.mkdir(parents=True, exist_ok=True)
        (self.root / path).write_text(text)

    def run_in(self, *args, env=None, check=True):
        return subprocess.run(
            args, cwd=self.root, env={**self.env, **(env or {})}, capture_output=True, text=True, check=check
        )

    def git(self, *args):
        self.run_in("git", "-c", "user.email=t@t", "-c", "user.name=t", *args)

    def commit(self, message):
        self.git("add", "-A")
        self.git("commit", "-qm", message)

    def checkout(self):
        # A fresh checkout gives every file a time after every cached build;
        # set it an hour ahead rather than waiting for the clock.
        checked_out = time.time() + 3600
        for path in self.run_in("git", "ls-files").stdout.split():
            os.utime(self.root / path, (checked_out, checked_out))

    def mtime(self, command):
        return self.run_in(sys.executable, str(MTIME), command, MANIFEST).stdout

    def cargo(self, *args, want=None):
        return self.run_in(
            "cargo", *args, "--profile", "ci-verify", env={"WANT": want} if want else None, check=False
        )

    def ci_build(self, *packages, test=False, want=None):
        """One CI job: restore, apply, build, record."""
        self.checkout()
        self.mtime("apply")
        for package in packages:
            if test:
                result = self.cargo("test", "-p", package, want=want)
            else:
                result = self.cargo("build", "-p", package)
            if result.returncode != 0:
                return result
        self.mtime("record")
        return result

    def builds(self, package):
        fingerprints = self.root / "target/ci-verify/.fingerprint"
        return sorted(p.name for p in fingerprints.iterdir() if p.name.rsplit("-", 1)[0] == package)

    def test_other_feature_build_from_older_sources_is_dropped(self):
        self.assertEqual(self.ci_build("b", "c").returncode, 0)
        # The next cached build changes a but only builds a with feature x.
        self.write("a/src/lib.rs", "pub fn old() -> u32 { 1 }\npub fn new() -> u32 { 2 }\n")
        self.commit("a: new")
        self.assertEqual(self.ci_build("b").returncode, 0)
        kept = self.builds("b")
        # A run that needs a without x must rebuild it, not link the old one.
        self.write("c/src/lib.rs", FILES["c/src/lib.rs"].replace("a::old()", "a::new()"))
        self.commit("c: new")
        self.checkout()
        out = self.mtime("apply")
        self.assertIn("1 not built from these sources dropped", out)
        result = self.cargo("build", "-p", "c")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Compiling a ", result.stderr)
        self.assertEqual(self.builds("b"), kept)

    def test_input_outside_the_package_is_tracked(self):
        self.assertEqual(self.ci_build("b", "c", test=True, want="one").returncode, 0)
        self.write("shared/data.txt", "two\n")
        self.commit("data")
        self.assertEqual(self.ci_build("b").returncode, 0)
        result = self.ci_build("c", test=True, want="two")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        # Same sources again: nothing to compile.
        result = self.ci_build("c", test=True, want="two")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertNotIn("Compiling", result.stderr)

    def test_cache_without_ledger_rebuilds_workspace_crates(self):
        self.assertEqual(self.ci_build("b", "c").returncode, 0)
        (self.root / "target/ci-verify/verify-unit-sources.json").unlink()
        self.checkout()
        out = self.mtime("apply")
        self.assertIn("0 cached workspace crate builds kept", out)
        result = self.cargo("build", "-p", "b", "-p", "c")
        self.assertEqual(result.returncode, 0, result.stderr)
        for package in ("a", "b", "c"):
            self.assertIn(f"Compiling {package} ", result.stderr)


if __name__ == "__main__":
    unittest.main()
