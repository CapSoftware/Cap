import importlib.util
import io
import subprocess
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SPEC = importlib.util.spec_from_file_location(
    "video_only_export_parity",
    Path(__file__).with_name("check-video-only-export-parity.py"),
)
CHECKER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKER)


class VirtualChunk:
    def __init__(self, size, tracking):
        self.size = size
        self.tracking = tracking
        tracking["live"] += 1
        tracking["peak"] = max(tracking["peak"], tracking["live"])

    def __len__(self):
        return self.size

    def __iter__(self):
        return iter((0, 255))

    def __del__(self):
        self.tracking["live"] -= 1


class VirtualAlphaStream:
    def __init__(self, size):
        self.remaining = size
        self.tracking = {"live": 0, "peak": 0}
        self.reads = 0

    def read(self, size=-1):
        if not 0 < size <= CHECKER.ALPHA_READ_BYTES:
            raise AssertionError("Alpha reads must have a bounded positive size")
        self.reads += 1
        size = min(size, self.remaining)
        self.remaining -= size
        return VirtualChunk(size, self.tracking) if size else b""


class AlphaExtremaTests(unittest.TestCase):
    def test_long_virtual_stream_has_bounded_reads_and_retention(self):
        stream = VirtualAlphaStream(640 * 360 * 15 * 1800)
        self.assertEqual(CHECKER.read_alpha_extrema(stream), (0, 255))
        self.assertEqual(stream.remaining, 0)
        self.assertGreater(stream.reads, 90_000)
        self.assertLessEqual(stream.tracking["peak"], 2)
        self.assertEqual(stream.tracking["live"], 0)

    def test_empty_transparent_opaque_and_mixed_alpha(self):
        for data, expected in [
            (b"", (None, None)),
            (b"\x00" * 17, (0, 0)),
            (b"\xff" * 17, (255, 255)),
            (b"\x00\x7f\xff", (0, 255)),
        ]:
            with self.subTest(data=data):
                self.assertEqual(CHECKER.read_alpha_extrema(io.BytesIO(data)), expected)

    def test_ffmpeg_failure_after_valid_alpha_is_propagated(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout = io.BytesIO(b"\x00\xff")
        process.wait.return_value = 7
        with patch.object(CHECKER.subprocess, "Popen", return_value=process) as spawn:
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                CHECKER.alpha_extrema(Path("baseline.mov"))
        self.assertEqual(failure.exception.returncode, 7)
        self.assertEqual(spawn.call_args.kwargs, {"stdout": subprocess.PIPE})
        process.wait.assert_called_once_with()
        process.kill.assert_not_called()

    def test_read_failure_kills_and_reaps_ffmpeg(self):
        process = MagicMock()
        process.__enter__.return_value = process
        process.stdout.read.side_effect = OSError("Broken alpha read")
        with patch.object(CHECKER.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(OSError, "Broken alpha read"):
                CHECKER.alpha_extrema(Path("baseline.mov"))
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
