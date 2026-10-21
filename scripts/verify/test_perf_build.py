import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("perf-build.py").resolve()
OLD = 946684800


class PerformanceBuildCacheTests(unittest.TestCase):
    def test_changed_library_is_rebuilt_after_another_profile_normalizes_its_mtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "src").mkdir()
            (root / "tests").mkdir()
            (root / "target" / "Frameworks").mkdir(parents=True)
            (root / "Cargo.toml").write_text(
                '[package]\nname = "cap-verify"\nversion = "0.1.0"\nedition = "2021"\n'
            )
            source = root / "src" / "lib.rs"
            source.write_text("pub fn value() -> u32 { 1 }\n")
            for target in ["export", "seek", "playback"]:
                (root / "tests" / f"{target}.rs").write_text(
                    '#[test]\nfn current_library() {\n'
                    'let expected: u32 = std::env::var("EXPECTED").unwrap().parse().unwrap();\n'
                    'assert_eq!(cap_verify::value(), expected);\n}\n'
                )
            env = dict(os.environ, CARGO_TARGET_DIR=str(root / "target"))
            self.run_command(root, env, "git", "init", "--quiet")
            self.run_command(root, env, "cargo", "generate-lockfile", "--offline")
            for version in [1, 2, 1]:
                source.write_text(f"pub fn value() -> u32 {{ {version} }}\n")
                self.run_command(root, env, "git", "add", "Cargo.toml", "Cargo.lock", "src", "tests")
                os.utime(source, (OLD, OLD))
                output = root / f"build-{version}"
                self.run_command(root, env, sys.executable, str(SCRIPT), str(root), str(output))
                manifest = json.loads((output / "binaries.json").read_text())
                self.run_command(
                    root,
                    dict(env, EXPECTED=str(version)),
                    manifest["binaries"]["playback"],
                )
            source.write_text("pub fn broken(\n")
            self.run_command(root, env, "git", "add", "src/lib.rs")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(root), str(root / "broken-build")],
                cwd=root,
                env=env,
                capture_output=True,
                text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('"reason":"compiler-message"', result.stdout)

    def run_command(self, root, env, *command):
        result = subprocess.run(command, cwd=root, env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
