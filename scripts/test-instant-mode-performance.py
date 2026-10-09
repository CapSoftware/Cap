import csv
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location(
	"instant_performance", Path(__file__).with_name("instant-mode-performance-macos.py")
)
PERF = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PERF)


class ProcessMetricsTests(unittest.TestCase):
	def summarize(self, samples, expected_pids=None):
		with tempfile.TemporaryDirectory() as directory:
			path = Path(directory) / "processes.csv"
			with path.open("w", newline="") as handle:
				writer = csv.DictWriter(handle, fieldnames=[
					"sample", "elapsed_s", "pid", "name", "cpu_pct", *sorted(PERF.NUMERIC_COLUMNS)
				])
				writer.writeheader()
				for sample, elapsed, pid, cpu in samples:
					writer.writerow({
						**dict.fromkeys(PERF.NUMERIC_COLUMNS, 0),
						"sample": sample,
						"elapsed_s": elapsed,
						"pid": pid,
						"name": f"process-{pid}",
						"cpu_pct": cpu,
						"user_ns": int(elapsed * cpu * 10_000_000),
						"disk_write_bytes": int(elapsed * 200),
					})
			return PERF.summarize_process_csv(path, 10, expected_pids)

	def test_cpu_includes_the_first_measured_interval(self):
		result = self.summarize([(1, 1, 10, 100), (2, 2, 10, 100)])
		self.assertEqual(result["cpu_average_pct"], 100)
		self.assertEqual(result["cpu_time_seconds"], 2)
		self.assertEqual(result["process_breakdown"][0]["cpu_average_pct"], 100)
		self.assertEqual(result["disk_write_bytes_per_second"], 200)
		self.assertEqual(result["counter_elapsed_seconds"], 1)
		self.assertTrue(result["complete_samples"])

	def test_cpu_weights_unequal_intervals_and_sums_processes(self):
		result = self.summarize([
			(1, 1, 10, 100), (1, 1, 11, 50),
			(2, 3, 10, 25), (2, 3, 11, 50),
		])
		self.assertEqual(result["cpu_average_pct"], 100)
		self.assertEqual(result["cpu_time_seconds"], 3)

	def test_single_sample_has_cpu_but_no_counter_rate(self):
		result = self.summarize([(1, 1, 10, 75)])
		self.assertEqual(result["cpu_average_pct"], 75)
		self.assertIsNone(result["disk_write_bytes_per_second"])

	def test_missing_process_or_sample_cannot_be_complete(self):
		for samples, expected in [
			([(1, 1, 10, 10), (2, 2, 10, 10)], [10, 11]),
			([(1, 1, 10, 10), (3, 3, 10, 10)], [10]),
			([(1, 1, 10, 10), (1, 1, 10, 10)], [10]),
		]:
			with self.subTest(samples=samples):
				self.assertFalse(self.summarize(samples, expected)["complete_samples"])

	def test_incomplete_phases_do_not_enter_comparison_aggregates(self):
		result = PERF.aggregate_runs([{"phases": [
			{"name": "recording", "valid_for_comparison": False,
				"process_metrics": {"cpu_average_pct": 1}, "network": {}},
			{"name": "recording", "valid_for_comparison": True,
				"process_metrics": {"cpu_average_pct": 50}, "network": {}},
		]}])
		self.assertEqual(result["recording"]["cpu_average_pct"]["median"], 50)

	def test_encoder_descendants_are_counted_once(self):
		apps = '\n'.join([
			'1) "cap-desktop" ASN:0x1:', '    pid = 10',
			'2) "cap-desktop Graphics and Media" ASN:0x2:',
			'    bundleID="com.apple.WebKit.GPU"', '    pid = 11',
			'3) "Other App" ASN:0x3:', '    pid = 99',
		])
		processes = '10 1 cap-desktop\n11 10 WebKit\n12 10 cap-muxer\n13 12 helper\n99 1 Other App\n'
		with patch.object(PERF, "run", side_effect=[
			subprocess.CompletedProcess([], 0, stdout=apps),
			subprocess.CompletedProcess([], 0, stdout=processes),
		]):
			pids, roles = PERF.associated_pids(10)
		self.assertEqual(pids, [10, 11, 12, 13])
		self.assertEqual([role["role"] for role in roles], ["app", "webkit-gpu", "child", "child"])


if __name__ == "__main__":
	unittest.main()
