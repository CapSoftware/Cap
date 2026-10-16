import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("verify_diff", Path(__file__).with_name("diff.py"))
diff = importlib.util.module_from_spec(spec)
spec.loader.exec_module(diff)


def record(count=0, unobserved=None, sample=None):
    result = {
        "outcome": "xfail" if count else "pass",
        "failures": {"missing-after-hold": []} if count else {},
        "measures": {"missing-after-hold": {"count": [count, count], "pictures": [count, count]}} if count else {},
        "unobserved": unobserved or {},
    }
    if sample is not None:
        result["_sample"] = sample
    return result


def compare(base, main):
    return diff.compare_case(diff.summarize(base), diff.summarize(main), 0, 0)


class ComparisonTests(unittest.TestCase):
    def test_lost_coverage_is_worse_for_passing_and_failing_baselines(self):
        main = record(unobserved={"sync-screen-mic": "track absent"})
        for failed in [False, True]:
            with self.subTest(failed=failed):
                base = record()
                if failed:
                    base["failures"] = {"sync-screen-mic": []}
                verdict, reasons = compare([base], [main])
                self.assertEqual(verdict, "WORSE")
                self.assertEqual(reasons, ["sync-screen-mic: baseline observed -> main unobserved (lost coverage)"])

    def test_coverage_gain_does_not_hide_simultaneous_loss(self):
        base = record(unobserved={"sync-screen-mic": "track absent"})
        main = record(unobserved={"sync-screen-system": "track absent"})
        bs, ms = diff.summarize([base]), diff.summarize([main])
        self.assertEqual(diff.compare_case(bs, ms, 0, 0)[0], "WORSE")
        self.assertEqual(diff.coverage_gained(bs, ms), ["sync-screen-mic"])
        self.assertEqual(diff.coverage_lost(bs, ms), ["sync-screen-system"])

    def test_partial_baseline_observation_still_detects_total_loss(self):
        unseen = record(unobserved={"sync-screen-mic": "track absent"})
        self.assertEqual(compare([unseen, record()], [unseen, unseen])[0], "WORSE")

    def test_partial_main_observation_is_not_total_loss(self):
        unseen = record(unobserved={"sync-screen-mic": "track absent"})
        self.assertEqual(diff.coverage_lost(diff.summarize([record()]), diff.summarize([unseen, record()])), [])

    def test_unobserved_on_both_sides_is_not_lost_coverage(self):
        unseen = record(unobserved={"sync-screen-mic": "track absent"})
        self.assertEqual(compare([unseen], [unseen]), ("EQUAL", []))

    def test_lost_distribution_coverage_is_worse_instead_of_insufficient(self):
        unseen = record(unobserved={"missing-after-hold": "track absent"})
        self.assertEqual(compare([record(1)], [unseen])[0], "WORSE")

    def test_cli_reports_coverage_lost_and_gained_separately(self):
        with tempfile.TemporaryDirectory() as root:
            root = Path(root)
            base = record(unobserved={"sync-screen-mic": "track absent"})
            main = record(unobserved={"sync-screen-system": "track absent"})
            for side, rec in [("base", base), ("main", main)]:
                path = root / side / "verify-report-macos-fast"
                path.mkdir(parents=True)
                rec.update({"suite": "export", "case": "a"})
                (path / "records.jsonl").write_text(json.dumps(rec) + "\n")
            result = subprocess.run(
                [sys.executable, "-B", str(Path(__file__).with_name("diff.py")), str(root / "base"), str(root / "main"), "--json", str(root / "diff.json")],
                check=True, capture_output=True, text=True,
            )
            self.assertIn("| coverage gained | coverage lost |", result.stdout)
            output = json.loads((root / "diff.json").read_text())["macos"]
            for category in ["WORSE", "COVERAGE-LOST", "COVERAGE-GAINED"]:
                self.assertEqual(output[category][0][0], "export::a")

    def test_absent_track_is_coverage_gained_even_when_main_fails(self):
        base = record(unobserved={"sync-screen-mic": "track absent"})
        main = record()
        main["failures"] = {"sync-screen-mic": []}
        self.assertEqual(compare([base], [main])[0], "COVERAGE-GAINED")

    def test_coverage_gained_does_not_hide_other_regression(self):
        base = record(unobserved={"sync-screen-mic": "track absent"})
        main = record()
        main["failures"] = {"sync-screen-mic": [], "timestamps": []}
        verdict, reasons = compare([base], [main])
        self.assertEqual(verdict, "WORSE")
        self.assertEqual(reasons, ["+timestamps"])

    def test_single_capture_cannot_establish_distribution(self):
        self.assertEqual(compare([record(1)], [record(2)])[0], "INSUFFICIENT")

    def test_passing_recording_still_requires_three_runs_for_baseline_gate(self):
        base, main = record(), record()
        base["case"] = main["case"] = "recording/instant/long-holds"
        self.assertEqual(compare([base], [main])[0], "INSUFFICIENT")

    def test_consistently_above_baseline_range_is_worse(self):
        self.assertEqual(compare([record(1), record(2), record(1)], [record(3), record(4), record(3)])[0], "WORSE")

    def test_overlap_is_explicit_not_equal_or_worse(self):
        self.assertEqual(compare([record(1), record(2), record(1)], [record(2), record(3), record(2)])[0], "OVERLAP")

    def test_absence_of_class_counts_as_zero_per_run(self):
        self.assertEqual(compare([record(), record(), record()], [record(1), record(1), record(1)])[0], "WORSE")

    def test_retries_do_not_count_as_independent_captures(self):
        self.assertEqual(compare([record(1, sample="same") for _ in range(3)], [record(2), record(2), record(2)])[0], "INSUFFICIENT")

    def test_partial_observability_does_not_hide_measured_failures(self):
        base = record(unobserved={"sync-screen-mic": "track absent"})
        observed = record()
        main = record()
        main["failures"] = {"sync-screen-mic": []}
        self.assertEqual(compare([base, observed], [main])[0], "WORSE")

    def test_other_classes_keep_zero_tolerance(self):
        base, main = record(), record()
        for rec, value in [(base, 1), (main, 2)]:
            rec["failures"] = {"timestamps": []}
            rec["measures"] = {"timestamps": {"count": [value, value]}}
        self.assertEqual(compare([base], [main])[0], "WORSE")


if __name__ == "__main__":
    unittest.main()
