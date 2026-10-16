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


def measured(value, case="export/instant-gated-mic-only/output/mp4/native", cls="sync-mic", metric="offset-ms", sample=None):
    result = record(sample=sample)
    result.update(case=case, failures={cls: []}, measures={cls: {metric: [value, value]}})
    return result


class ComparisonTests(unittest.TestCase):
    def test_witness_frame_movement_does_not_change_severity(self):
        for cls in ["stale", "future", "unreadable", "timestamps", "nondeterministic"]:
            with self.subTest(cls=cls):
                base = measured(4, case="editing/export/basic/seed-10", cls=cls, metric="screen-frames")
                base["measures"][cls]["frame"] = [63, 63]
                main = json.loads(json.dumps(base))
                main["measures"][cls]["frame"] = [109, 109]
                self.assertEqual(compare([base], [main]), ("EQUAL", []))
                main["measures"][cls]["screen-frames"] = [3, 3]
                self.assertEqual(compare([base], [main])[0], "BETTER")
                main["measures"][cls]["screen-frames"] = [5, 5]
                self.assertEqual(compare([base], [main])[0], "WORSE")

    def test_witness_frame_does_not_hide_new_classes_or_larger_deltas(self):
        for cls in ["stale", "future", "unreadable", "grid-rounding"]:
            with self.subTest(cls=cls):
                main = measured(109, case="export/basic", cls=cls, metric="frame")
                self.assertEqual(compare([dict(record(), case="export/basic")], [main])[0], "WORSE")
                base = json.loads(json.dumps(main))
                base["measures"][cls]["delta"] = [1, 1]
                main["measures"][cls]["delta"] = [2, 2]
                self.assertEqual(compare([base], [main])[0], "WORSE")

    def test_continuous_metrics_require_three_independent_runs(self):
        self.assertEqual(compare([measured(15.2)], [measured(15.3)])[0], "INSUFFICIENT")
        self.assertEqual(compare([measured(15.2, sample="same") for _ in range(3)], [measured(16) for _ in range(3)])[0], "INSUFFICIENT")

    def test_continuous_overlap_and_one_resolution_step_are_not_worse(self):
        base = [measured(v) for v in [15.1, 15.2, 15.3]]
        for values in [[15.2, 15.3, 15.4], [15.4, 15.4, 15.4]]:
            with self.subTest(values=values):
                self.assertEqual(compare(base, [measured(v) for v in values])[0], "OVERLAP")

    def test_continuous_separated_ranges_are_worse(self):
        self.assertEqual(compare([measured(v) for v in [15.1, 15.2, 15.3]], [measured(v) for v in [15.5, 15.6, 15.5]])[0], "WORSE")

    def test_signed_offsets_compare_magnitude(self):
        self.assertEqual(compare([measured(-15) for _ in range(3)], [measured(-17) for _ in range(3)])[0], "WORSE")

    def test_timing_metric_outside_recording_cases_uses_distribution(self):
        self.assertEqual(compare([measured(1, case="playback/basic", metric="warm-up-s")], [measured(2, case="playback/basic", metric="warm-up-s")])[0], "INSUFFICIENT")

    def test_reporter_precision_is_preserved_for_each_timing_unit(self):
        for metric, base, within, beyond in [
            ("screen-start-late-ms", 200, 201, 202),
            ("screen-lost-s", 3.25, 3.26, 3.27),
            ("mic-after-start-s", 0.11, 0.12, 0.13),
            ("off-periods", 1, 1.01, 1.02),
        ]:
            with self.subTest(metric=metric):
                records = [measured(base, case="export/basic", metric=metric) for _ in range(3)]
                self.assertEqual(compare(records[:1], [measured(within, case="export/basic", metric=metric)])[0], "INSUFFICIENT")
                self.assertEqual(compare(records, [measured(within, case="export/basic", metric=metric) for _ in range(3)])[0], "OVERLAP")
                self.assertEqual(compare(records, [measured(beyond, case="export/basic", metric=metric) for _ in range(3)])[0], "WORSE")

    def test_fresh_crash_counts_use_frame_resolution(self):
        base = [measured(176, case="crash/recorder-kill/oop/random0", cls="loss", metric="frames") for _ in range(3)]
        for value, expected in [(177, "OVERLAP"), (178, "WORSE")]:
            main = [measured(value, case="crash/recorder-kill/oop/random0", cls="loss", metric="frames") for _ in range(3)]
            self.assertEqual(compare(base, main)[0], expected)

    def test_missing_metric_is_insufficient_not_zero(self):
        base = [measured(15) for _ in range(3)]
        base[0]["measures"] = {}
        self.assertEqual(compare(base, [measured(17) for _ in range(3)])[0], "INSUFFICIENT")

    def test_new_fresh_class_needs_consistent_occurrence(self):
        base = [dict(record(), case="crash/example") for _ in range(3)]
        main = [measured(1, case="crash/example", cls="unexpected", metric="count") for _ in range(3)]
        self.assertEqual(compare(base[:1], main[:1])[0], "INSUFFICIENT")
        self.assertEqual(compare(base, main)[0], "WORSE")
        self.assertEqual(compare(base, main[:2] + base[:1])[0], "OVERLAP")

    def test_legacy_instant_telemetry_preserves_signed_interval(self):
        rec = measured(-45.9, case="export/instant/output/mp4/native", cls="sync-system")
        rec["measures"]["sync-mic"] = {"offset-ms": [14.0, 14.2]}
        rec["measures"]["sync-system"]["offset-ms"] = [-46.0, -45.8]
        actual = diff.normalized_measures(rec)["sync-system"]
        self.assertEqual(actual["mic-offset-ms"], [14.0, 14.2])
        self.assertEqual(actual["system-minus-mic-ms"], [-60.2, -59.8])
        self.assertNotIn("mic-offset-ms", rec["measures"]["sync-system"])

    def test_legacy_normalization_does_not_override_measurements_or_invent_sources(self):
        rec = measured(8.5, case="export/instant/output/mp4/native", cls="sync-system")
        self.assertNotIn("mic-offset-ms", diff.normalized_measures(rec)["sync-system"])
        rec["measures"]["sync-mic"] = {"offset-ms": [15.1, 15.1]}
        rec["measures"]["sync-system"]["system-minus-mic-ms"] = [-6.7, -6.7]
        self.assertEqual(diff.normalized_measures(rec)["sync-system"]["system-minus-mic-ms"], [-6.7, -6.7])
        rec["unobserved"] = {"sync-mic": "track absent"}
        self.assertNotIn("mic-offset-ms", diff.normalized_measures(rec)["sync-system"])

    def test_legacy_and_current_instant_records_compare_equally(self):
        legacy = measured(8.5, case="export/instant/output/mp4/native", cls="sync-system")
        legacy["measures"]["sync-mic"] = {"offset-ms": [15.1, 15.1]}
        current = json.loads(json.dumps(legacy))
        current["measures"]["sync-system"].update({"mic-offset-ms": [15.1, 15.1], "system-minus-mic-ms": [-6.6, -6.6]})
        self.assertEqual(compare([legacy] * 3, [current] * 3), ("EQUAL", []))

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
