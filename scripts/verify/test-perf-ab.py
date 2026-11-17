import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("perf-ab.py").resolve()
SPEC = importlib.util.spec_from_file_location("perf_ab", SCRIPT)
PERF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERF)


@unittest.skipUnless(hasattr(os, "wait4"), "The performance runner requires POSIX wait4")
class PerformanceReportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        (self.root / "crates" / "verify").mkdir(parents=True)

    def side(self, records, exit_code=0):
        binary = self.root / "fixture.py"
        binary.with_suffix(".json").write_text(json.dumps({"records": records, "exit": exit_code}))
        binary.write_text(f"#!{sys.executable}\n" + r"""import json
import os
from pathlib import Path
import sys

Path(__file__).with_suffix(".started").touch()
fixture = json.loads(Path(__file__).with_suffix(".json").read_text())
if fixture["records"]:
    report = Path(os.environ["CAP_VERIFY_REPORT_DIR"])
    path = report / f"cap-verify-{os.getpid()}.jsonl"
    path.write_text("".join(json.dumps(row) + "\n" for row in fixture["records"]))
print("fixture completed")
sys.exit(fixture["exit"])
""")
        binary.chmod(0o700)
        return {
            "worktree": str(self.root),
            "binaries": {target: str(binary) for _, target, _, _, _ in PERF.WORKLOADS},
        }

    def test_existing_reports_are_preserved_and_never_used(self):
        side = self.side([])
        report = self.root / "reports"
        report.mkdir()
        stale = report / "cap-verify-123.jsonl"
        previous = json.dumps({"case": "export/basic/output/mp4/native", "outcome": "pass"}) + "\n"
        stale.write_text(previous)
        log = report / "test.log"
        log.write_text("previous run\n")
        with self.assertRaises(FileExistsError):
            PERF.run_once(side, "export", "export/basic/*", "fast", self.root / "fixtures", report)
        self.assertEqual(stale.read_text(), previous)
        self.assertEqual(log.read_text(), "previous run\n")
        self.assertFalse((self.root / "fixture.started").exists())

    def test_fresh_reports_preserve_exit_status_and_outcomes(self):
        outcomes = ["pass", "xfail", "xpass", "fail", "unsupported", "inconclusive"]
        rows = [{"case": f"export/basic/{outcome}", "outcome": outcome} for outcome in outcomes]
        result = PERF.run_once(
            self.side(rows, 101), "export", "export/basic/*", "fast",
            self.root / "fixtures", self.root / "reports",
        )
        self.assertEqual(result["exit"], 101)
        self.assertEqual(result["outcomes"], {
            f"export/basic/{outcome}": "ran" if outcome in {"pass", "xfail", "xpass"} else outcome
            for outcome in outcomes
        })

    def test_cli_rejects_fresh_runs_that_report_no_cases(self):
        manifest = self.root / "binaries.json"
        manifest.write_text(json.dumps(self.side([])))
        output = self.root / "output"
        output.mkdir()
        result = subprocess.run([
            sys.executable, "-B", str(SCRIPT), "--base", str(manifest), "--head", str(manifest),
            "--fixtures", str(self.root / "fixtures"), "--out", str(output), "--pairs", "1",
        ], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("not measured:", result.stdout)
        self.assertEqual((output / "perf-budget.md").read_text().count("BROKEN:"), len(PERF.WORKLOADS))


if __name__ == "__main__":
    unittest.main()
