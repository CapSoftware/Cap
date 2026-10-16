import importlib.util
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
