#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest


SPEC = importlib.util.spec_from_file_location("capbench", Path(__file__).with_name("capbench.py"))
capbench = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(capbench)

BANNER = "=" * 60

PLAYBACK_OUTPUT = f"""
--- DECODE-ONLY BENCHMARK ---
{BANNER}
  DECODE-ONLY
{BANNER}
  Frames rendered: 300
  Effective FPS: 197.2
  Decode:
    avg=5.07ms  min=0.00ms  max=184.49ms
    p50=3.75ms  p95=7.81ms  p99=27.60ms
{BANNER}
  FULL PIPELINE - Full (1920x1080)
{BANNER}
  Effective FPS: 32.6
  Decode:
    avg=6.09ms  min=0.04ms  max=17.48ms
    p50=6.00ms  p95=11.47ms  p99=14.38ms
  GPU Render+Readback:
    avg=24.59ms  min=5.36ms  max=50.49ms
    p50=25.11ms  p95=31.70ms  p99=35.18ms
  Total (decode+render):
    avg=30.68ms  min=5.40ms  max=55.99ms
    p50=30.95ms  p95=39.37ms  p99=47.18ms
{BANNER}
  FULL PIPELINE - Half (1248x702)
{BANNER}
  Effective FPS: 31.9
  Total (decode+render):
    avg=31.33ms  min=12.97ms  max=60.85ms
    p50=31.03ms  p95=37.79ms  p99=47.13ms
{BANNER}
  SCRUBBING (Half resolution)
{BANNER}
  Effective FPS: 9.2
  Decode:
    avg=82.37ms  min=23.55ms  max=846.34ms
    p50=68.54ms  p95=105.12ms  p99=846.34ms
  Total (decode+render):
    avg=108.65ms  min=46.38ms  max=909.39ms
    p50=93.93ms  p95=141.57ms  p99=909.39ms
"""

DECODE_OUTPUT = """
DECODER CREATION
  Time to create decoder: 97.00ms
SEQUENTIAL DECODE PERFORMANCE
  Frames decoded: 100
  Effective FPS: 189.0
RANDOM ACCESS PERFORMANCE
  Samples: 50
  Avg access time: 107.38ms
  P50: 105.14ms
  P95: 150.12ms
"""


def timed(text):
    return [(index * 0.1, line) for index, line in enumerate(text.splitlines())]


class CapbenchTests(unittest.TestCase):
    def test_playback_picks_full_and_scrub_totals(self):
        metrics = capbench.parse_playback_pipeline(timed(PLAYBACK_OUTPUT))
        self.assertEqual(metrics["decode_fps"], 197.2)
        self.assertEqual(metrics["pipeline_fps"], 32.6)
        self.assertEqual(metrics["render_p50_ms"], 25.11)
        self.assertEqual(metrics["pipeline_p95_ms"], 39.37)
        self.assertEqual(metrics["scrub_decode_p50_ms"], 68.54)
        self.assertEqual(metrics["scrub_p50_ms"], 93.93)
        self.assertEqual(metrics["scrub_p95_ms"], 141.57)

    def test_playback_runs_with_failed_frames_are_invalid(self):
        failed = PLAYBACK_OUTPUT + "\n  Decode failures: 3\n  Render failures: 1\n"
        with self.assertRaisesRegex(capbench.InvalidRun, "4 failed frames"):
            capbench.parse_playback_pipeline(timed(failed))

    def test_decode_metrics(self):
        metrics = capbench.parse_decode(timed(DECODE_OUTPUT))
        self.assertEqual(metrics, {
            "decoder_create_ms": 97.0, "sequential_fps": 189.0,
            "random_avg_ms": 107.38, "random_p95_ms": 150.12,
        })

    def test_decode_runs_with_failed_reads_are_invalid(self):
        failed = DECODE_OUTPUT + "\nRANDOM ACCESS PERFORMANCE\n  Failures: 50\n"
        with self.assertRaisesRegex(capbench.InvalidRun, "50 failed reads"):
            capbench.parse_decode(timed(failed))
        clean = DECODE_OUTPUT + "\n  Frames failed: 0\n"
        self.assertIn("sequential_fps", capbench.parse_decode(timed(clean)))

    def test_fixture_inside_the_work_directory_is_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            fixture = out / "work" / "fixture" / "run" / "reference.cap"
            fixture.mkdir(parents=True)
            args = SimpleNamespace(
                bench=["decode-display"], out=str(out), label="run", fixture=str(fixture), bin_dir=tmp,
                variant=[], env=[], screen=None, animate=False, affinity=None,
            )
            with self.assertRaisesRegex(SystemExit, "overlap"):
                capbench.cmd_run(args)
            self.assertTrue(fixture.exists())

    def test_binaries_inside_the_work_directory_are_not_deleted(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            bins = out / "work" / "build"
            bins.mkdir(parents=True)
            fixture = Path(tmp) / "reference.cap"
            fixture.mkdir()
            args = SimpleNamespace(
                bench=["decode-display"], out=str(out), label="run", fixture=str(fixture), bin_dir=str(bins),
                variant=[], env=[], screen=None, animate=False, affinity=None,
            )
            with self.assertRaisesRegex(SystemExit, "inside the work directory"):
                capbench.cmd_run(args)
            self.assertTrue(bins.exists())

    def test_labels_that_are_not_plain_file_names_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            fixture = Path(tmp) / "reference.cap"
            fixture.mkdir()
            for label in ["feature/gpu", "..", ""]:
                args = SimpleNamespace(
                    bench=["decode-display"], out=str(Path(tmp) / "out"), label=label, fixture=str(fixture),
                    bin_dir=tmp, variant=[], env=[], screen=None, animate=False, affinity=None,
                )
                with self.assertRaisesRegex(SystemExit, "file name"):
                    capbench.cmd_run(args)

    def test_startup_check_finds_missing_helpers(self):
        args = SimpleNamespace(fixture=".", bin_dir=str(Path(__file__).parent), screen=None, animate=False, affinity=None)
        with self.assertRaisesRegex(FileNotFoundError, "cap-test"):
            capbench.BENCHES["record-studio-60"]["requires"](capbench.Context(args))

    def test_startup_metrics(self):
        lines = timed("Startup: avg=1159.3ms p50=671.2ms p95=2229.8ms\nFirst preview: avg=37.0ms p50=44.4ms p95=45.9ms")
        self.assertEqual(capbench.parse_startup(lines), {"startup_p50_ms": 671.2, "first_preview_p50_ms": 44.4})

    def test_export_progress_timing(self):
        lines = [
            (0.5, "Updated project-config.json migrated settings"),
            (1.0, '{"type":"Progress","rendered_count":0,"total_frames":100}'),
            (2.0, '{"type":"Progress","rendered_count":50,"total_frames":100}'),
            (3.0, '{"type":"Progress","rendered_count":100,"total_frames":100}'),
            (3.1, '{"type":"Completed","path":"x.mp4"}'),
        ]
        metrics = capbench.parse_export(lines)
        self.assertEqual(metrics["first_frame_s"], 2.0)
        self.assertEqual(metrics["frames"], 100.0)
        self.assertAlmostEqual(metrics["steady_fps"], 50.0)

    def test_export_problem_rejects_broken_exports(self):
        good = {"out_frames": 1850.0, "out_width": 1664.0, "out_height": 1080.0}
        self.assertIsNone(capbench.export_problem(good, 1850.0, "1920x1080"))
        self.assertIsNotNone(capbench.export_problem({}, 1850.0, "1920x1080"))
        self.assertIsNotNone(capbench.export_problem({**good, "out_frames": 0.0}, None, "1920x1080"))
        self.assertIsNotNone(capbench.export_problem({**good, "out_frames": 1849.0}, 1850.0, "1920x1080"))
        self.assertIsNotNone(capbench.export_problem({**good, "out_width": 0.0}, 1850.0, "1920x1080"))
        self.assertIsNotNone(capbench.export_problem({**good, "out_height": 2160.0}, 1850.0, "1920x1080"))

    def test_exports_ffprobe_cannot_read_are_invalid(self):
        if not capbench.shutil.which("ffprobe"):
            self.skipTest("ffprobe is not on PATH")
        post = capbench.BENCHES["export-1080p60"]["post"]
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "export.mp4").write_bytes(b"not an mp4")
            with self.assertRaisesRegex(capbench.InvalidRun, "ffprobe"):
                post(None, Path(tmp), {"frames": 100.0, "wall_s": 2.0})

    def test_compare_flags_only_separated_changes(self):
        def results(values):
            return {"benches": {"b": {"runs": [{"wall_s": v} for v in values], "better": {"wall_s": "lower"}}}}

        faster = capbench.compare(results([10.0, 10.1, 9.9, 10.2, 10.0]), results([8.0, 8.1, 7.9, 8.2, 8.0]))
        self.assertEqual(faster[0]["verdict"], "BETTER")
        slower = capbench.compare(results([10.0, 10.1, 9.9, 10.2, 10.0]), results([12.0, 12.1, 11.9, 12.2, 12.0]))
        self.assertEqual(slower[0]["verdict"], "WORSE")
        noise = capbench.compare(results([10.0, 12.0, 8.0, 11.0, 9.0]), results([10.5, 8.5, 11.5, 9.5, 12.5]))
        self.assertEqual(noise[0]["verdict"], "same")

    def test_invalid_recordings_fail_the_run(self):
        video = {"frame_count": 300, "duration_secs": 10.0}
        self.assertEqual(capbench.validated_video(json.dumps({"valid": True, "video_info": video}), 0), video)
        with self.assertRaisesRegex(capbench.InvalidRun, "Missing content directory"):
            capbench.validated_video(json.dumps({"valid": False, "errors": ["Missing content directory"]}), 0)
        with self.assertRaises(capbench.InvalidRun):
            capbench.validated_video("thread 'main' panicked", 101)

    def test_runs_missing_a_metric_are_invalid(self):
        better = capbench.BENCHES["decode-display"]["better"]
        complete = {key: 1.0 for key in better}
        self.assertEqual(capbench.missing_metrics(better, complete), [])
        crashed = {"wall_s": 0.4, "cpu_s": 0.1, "peak_commit_mb": 40.0}
        self.assertIn("sequential_fps", capbench.missing_metrics(better, crashed))
        no_job = {key: 1.0 for key in better if key not in capbench.JOB_METRICS}
        self.assertEqual(capbench.missing_metrics(better, no_job), [])
        self.assertNotIn("delivered_fps", capbench.BENCHES["record-instant-30"]["better"])
        self.assertIn("delivered_fps", capbench.BENCHES["record-studio-60"]["better"])

    def test_variant_env_is_scoped_per_label(self):
        env = capbench.parse_variant_env(["base", "t4"], ["t4:CAP_EXP_DECODE_THREADS=4", "t4:X=a=b"])
        self.assertEqual(env, {"base": {}, "t4": {"CAP_EXP_DECODE_THREADS": "4", "X": "a=b"}})
        with self.assertRaises(SystemExit):
            capbench.parse_variant_env(["base"], ["other:K=V"])

    def test_job_accounts_child_process_cpu(self):
        if sys.platform != "win32":
            self.skipTest("job object accounting is Windows-only")
        measured, lines = capbench.run_measured(
            [sys.executable, "-c", "import subprocess,sys; subprocess.run([sys.executable,'-c','sum(range(3*10**7))']); print('done')"],
            timeout=60,
        )
        self.assertEqual(measured["exit"], 0)
        self.assertGreaterEqual(measured["processes"], 2)
        self.assertGreater(measured["cpu_s"], 0.1)
        self.assertEqual(lines[-1][1], "done")


if __name__ == "__main__":
    unittest.main()
