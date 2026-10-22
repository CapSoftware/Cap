import importlib.util
import pathlib
import unittest

import numpy as np

spec = importlib.util.spec_from_file_location("intelligibility", pathlib.Path(__file__).with_name("benchmark-audio-intelligibility.py"))
benchmark = importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)


class AlignmentTests(unittest.TestCase):
	def test_delayed_or_advanced_audio_scores_the_same_overlapping_speech(self):
		x = np.random.default_rng(2240).normal(0, .05, 64000)
		for lag in [-400, 0, 400]:
			with self.subTest(lag=lag):
				y = np.roll(x, lag) * .8
				if lag > 0:
					y[:lag] = 0
				elif lag < 0:
					y[lag:] = 0
				result = benchmark.score_signals(x, x.copy(), y)
				self.assertEqual(result["lagMs"], lag / 16)
				self.assertEqual(result["evaluatedSamples"], len(x) - abs(lag))
				self.assertAlmostEqual(result["stoiDelta"], 0, places=6)
				self.assertGreater(result["outputSiSdr"], 90)
				if lag:
					self.assertLess(result["unalignedStoiDelta"], -.1)

	def test_input_and_output_use_the_same_trimmed_reference(self):
		rng = np.random.default_rng(2240)
		x = rng.normal(0, .05, 64000)
		noisy = x + rng.normal(0, .01, len(x))
		output = np.concatenate([np.zeros(400), noisy[:-400]])
		result = benchmark.score_signals(x, noisy, output)
		self.assertEqual(result["lagMs"], 25)
		self.assertAlmostEqual(result["stoiDelta"], 0, places=6)
		self.assertAlmostEqual(result["inputSiSdr"], result["outputSiSdr"], places=6)


if __name__ == "__main__":
	unittest.main()
