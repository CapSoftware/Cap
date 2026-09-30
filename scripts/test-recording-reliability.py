#!/usr/bin/env python3
import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import time
import unittest


SPEC = importlib.util.spec_from_file_location("reliability", Path(__file__).with_name("recording-reliability.py"))
reliability = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reliability)


class RecordingReliabilityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.project = self.root / "fixture.cap"
        self.project.mkdir()
        self.video = self.project / "display.mp4"
        self.video.write_bytes(b"nonempty owned fixture")

    def events(self, **stopped):
        return "\n".join(json.dumps(event) for event in [
            {"type": "started", "recordingId": "fixture", "pid": 123, "path": str(self.project)},
            {"type": "stopped", "path": str(self.project), "recordingMetaExists": True, **stopped},
        ])

    def report(self, **overrides):
        return {"valid": True, "projectPath": str(self.project), "recordingType": "studio", "checks": [
            {"role": "displayVideo", "path": str(self.video), "exists": True, "required": True}
        ], **overrides}

    def probe(self, **stream):
        return {"format": {"duration": "12"}, "streams": [
            {"codec_type": "video", "width": 1920, "height": 1080, "nb_read_frames": "360", **stream}
        ]}

    def test_complete_events_require_order_and_saved_metadata(self):
        self.assertEqual(len(reliability.capture_events(self.events(), self.project)), 2)
        for text in [self.events(recordingMetaExists=False), "\n".join(reversed(self.events().splitlines())), self.events() + "\n" + self.events().splitlines()[1]]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                reliability.capture_events(text, self.project)

    def test_error_event_cannot_be_hidden_by_successful_stop(self):
        text = self.events() + '\n{"type":"error","error":"disk write failed"}'
        with self.assertRaises(ValueError):
            reliability.capture_events(text, self.project)

    def test_malformed_json_duplicate_keys_and_nonfinite_values_rejected(self):
        for text in ['{"valid":false,"valid":true}', '{"duration":NaN}', "[]\n{}", "not json"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                reliability.strict_json(text)

    def test_success_event_cannot_reference_a_different_project(self):
        with self.assertRaises(ValueError):
            reliability.capture_events(self.events(path=str(self.root / "other.cap")), self.project)

    def test_zero_exit_and_error_log_is_not_clean_json(self):
        with self.assertRaises(ValueError):
            reliability.checked_json('{"valid":true}', "2026-08-30 ERROR encoder trailer failed")

    def test_missing_requested_tracks_fail_even_if_cli_valid_is_true(self):
        for requested in [("camera", None, False), (None, "mic", False), (None, None, True)]:
            with self.subTest(requested=requested), self.assertRaises(ValueError):
                reliability.project_media(self.report(), self.project, "studio", *requested)

    def test_existing_video_is_not_a_camera_or_audio_substitute(self):
        files = reliability.project_media(self.report(), self.project, "studio", None, None, False)
        self.assertEqual(files[0]["role"], "displayVideo")
        self.assertEqual(files[0]["path"], str(self.video))

    def test_invalid_project_report_cannot_pass_from_existing_files(self):
        for override in [{"valid": False}, {"problems": ["still recording"]}, {"missing": ["mic.ogg"]}, {"error": "failure"}]:
            with self.subTest(override=override), self.assertRaises(ValueError):
                reliability.project_media(self.report(**override), self.project, "studio", None, None, False)

    def test_empty_artifact_and_path_escape_rejected(self):
        self.video.write_bytes(b"")
        with self.assertRaises(ValueError):
            reliability.contained_file(self.video, self.project)
        outside = self.root / "outside.mp4"
        outside.write_bytes(b"private sentinel")
        with self.assertRaises(ValueError):
            reliability.contained_file(outside, self.project)
        self.assertEqual(outside.read_bytes(), b"private sentinel")

    def test_symlink_inside_project_cannot_hide_outside_artifact(self):
        linked = self.project / "linked.mp4"
        try:
            linked.symlink_to(self.video)
        except OSError:
            self.skipTest("Creating symlinks is unavailable on this test host")
        with self.assertRaises(ValueError):
            reliability.contained_file(linked, self.project)

    def test_duration_frozen_frame_count_and_missing_stream_rejected(self):
        for probe in [self.probe(duration="1"), self.probe(nb_read_frames="2"), self.probe(width=0), self.probe(codec_type="audio"), self.probe(duration="nan")]:
            with self.subTest(probe=probe), self.assertRaises(ValueError):
                reliability.media_metrics(probe, 12, 30, "video")
        self.assertEqual(reliability.media_metrics(self.probe(), 12, 30, "video")[0]["decodedFrames"], 360)

    def test_silent_audio_is_not_a_pass(self):
        for stderr in ["", "RMS level dB: -inf", "RMS level dB: -80.0"]:
            with self.subTest(stderr=stderr), self.assertRaises(ValueError):
                reliability.audio_levels(stderr)
        self.assertEqual(reliability.audio_levels("RMS level dB: -24.5")["maximumRmsDbfs"], -24.5)

    def test_packet_timestamps_preserve_reordered_presentation_and_audio_preroll(self):
        probe = {"streams": [{"index": 0, "codec_type": "video"}, {"index": 1, "codec_type": "audio"}], "packets": [
            {"stream_index": 0, "dts": -2, "pts": 0},
            {"stream_index": 1, "dts": -1024, "pts": -1024},
            {"stream_index": 0, "dts": -1, "pts": 2},
            {"stream_index": 1, "dts": 0, "pts": 0},
            {"stream_index": 0, "dts": 0, "pts": 1},
        ]}
        self.assertEqual(reliability.packet_timestamps(probe), {0: 3, 1: 2})

    def test_duplicate_reversed_and_missing_packet_timestamps_fail(self):
        for second in [0, -1, None, "1", True]:
            probe = {"streams": [{"index": 0, "codec_type": "video"}], "packets": [
                {"stream_index": 0, "dts": 0, "pts": 0},
                {"stream_index": 0, "dts": second, "pts": 1},
            ]}
            with self.subTest(second=second), self.assertRaises(ValueError):
                reliability.packet_timestamps(probe)
        for probe in [{"streams": [], "packets": []}, {"streams": [{"index": 0, "codec_type": "audio"}], "packets": []}]:
            with self.subTest(probe=probe), self.assertRaises(ValueError):
                reliability.packet_timestamps(probe)

    def test_pending_and_failed_requirements_cannot_become_success(self):
        self.assertEqual(reliability.aggregate([]), "FAIL")
        self.assertEqual(reliability.aggregate([{"status": "PASS"}, {"status": "PENDING"}]), "PENDING")
        self.assertEqual(reliability.aggregate([{"status": "PASS"}, {"status": "FAIL"}]), "FAIL")
        self.assertEqual(reliability.aggregate([{"status": "unknown"}]), "FAIL")

    def test_existing_root_is_never_replaced(self):
        sentinel = self.root / "keep.txt"
        sentinel.write_text("keep me", encoding="utf-8")
        with self.assertRaises(ValueError):
            reliability.main(["--cap", sys.executable, "--ffmpeg", sys.executable, "--ffprobe", sys.executable, "--head", "test", "--root", str(self.root), "--window", "explicit-owned-window", "--windows-job-source", __file__])
        self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep me")

    @unittest.skipIf(sys.platform == "win32", "POSIX process-group test; Windows requires the reviewed Job Object source")
    def test_owned_timeout_cannot_be_reported_as_success(self):
        binary = str(Path(sys.executable).resolve())
        runner = reliability.Runner(self.root, time.monotonic() + 10, {binary: reliability.sha256(binary)})
        with self.assertRaises(RuntimeError):
            runner.run("timeout", [binary, "-c", "import time; time.sleep(30)"], 0.1)
        receipt = runner.commands[0]
        self.assertTrue(receipt["timedOut"])
        self.assertTrue(receipt["forcedCleanup"])
        self.assertTrue(receipt["cleanupComplete"])
        self.assertFalse(receipt["passed"])

    @unittest.skipIf(sys.platform == "win32", "POSIX process supervision test")
    def test_nonzero_child_with_success_json_remains_failed(self):
        binary = str(Path(sys.executable).resolve())
        runner = reliability.Runner(self.root, time.monotonic() + 10, {binary: reliability.sha256(binary)})
        with self.assertRaises(RuntimeError):
            runner.run("exit-error", [binary, "-c", "print('{\"valid\":true}'); raise SystemExit(7)"], 2)
        self.assertEqual(runner.commands[0]["exitCode"], 7)
        self.assertFalse(runner.commands[0]["passed"])


if __name__ == "__main__":
    unittest.main()
