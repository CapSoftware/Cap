import { describe, expect, test } from "bun:test";
import {
	type AudioQualityMeasurements,
	planAudioQuality,
	validateAudioQualityMeasurements,
} from "../../lib/audio-quality-policy";

const input: AudioQualityMeasurements = {
	lufs: -35,
	truePeak: -16,
	lra: 6,
	duration: 80,
	channels: 1,
	sampleRate: 48000,
	sampleCount: 3840000,
};

describe("audio quality policy", () => {
	test("is disabled without shadow mode", () => {
		expect(planAudioQuality(input, { mode: "off", profile: "voice" })).toEqual({
			kind: "skip",
			reason: "disabled",
		});
	});

	test("requires affirmative speech-only evidence for voice processing", () => {
		expect(
			planAudioQuality(input, { mode: "shadow", profile: "voice" }),
		).toEqual({ kind: "skip", reason: "unconfirmed-speech-only" });
	});

	test("retains mixed audio dynamics and bounds gain", () => {
		const plan = planAudioQuality(input, { mode: "shadow", profile: "levels" });
		expect(plan).toMatchObject({
			kind: "candidate",
			filter: "volume=13.000000dB",
		});
		expect(
			planAudioQuality(
				{ ...input, truePeak: -4 },
				{ mode: "shadow", profile: "levels" },
			),
		).toMatchObject({ kind: "candidate", filter: "volume=2.000000dB" });
	});

	test.each([
		{ lufs: -33, truePeak: -25, gain: 12 },
		{ lufs: -38, truePeak: -25, gain: 16 },
		{ lufs: -50.48, truePeak: -31.03, gain: 28 },
		{ lufs: -55, truePeak: -45, gain: 28 },
		{ lufs: -50.48, truePeak: -4, gain: 2 },
	])(
		"bounds quiet correction by loudness and peaks: %j",
		({ gain, ...levels }) => {
			const quiet = { ...input, ...levels };
			expect(
				planAudioQuality(quiet, { mode: "shadow", profile: "levels" }),
			).toMatchObject({
				kind: "candidate",
				filter: `volume=${gain.toFixed(6)}dB`,
			});
			expect(
				validateAudioQualityMeasurements(
					quiet,
					{
						...quiet,
						lufs: quiet.lufs + gain,
						truePeak: quiet.truePeak + gain,
					},
					"levels",
				),
			).toEqual([]);
			expect(
				validateAudioQualityMeasurements(
					quiet,
					{ ...quiet, lufs: quiet.lufs + gain + 1 },
					"levels",
				),
			).toContain("excessive-gain");
		},
	);

	test("retains the lower loudness bound for experimental voice processing", () => {
		expect(
			planAudioQuality(
				{ ...input, lufs: -50.48, truePeak: -31.03 },
				{ mode: "shadow", profile: "voice", speechOnlyConfirmed: true },
			),
		).toEqual({ kind: "skip", reason: "unsafe-levels" });
	});

	test.each([
		{ lufs: Number.NEGATIVE_INFINITY },
		{ truePeak: Number.NaN },
		{ truePeak: 10.84 },
		{ lufs: -65 },
		{ lufs: -55.01 },
		{ duration: 1 },
		{ channels: 6 },
		{ sampleRate: 8000 },
		{ lufs: -14 },
		{ truePeak: -2.5 },
	])("leaves unsupported or risky input unchanged: %j", (patch) => {
		expect(
			planAudioQuality(
				{ ...input, ...patch },
				{ mode: "shadow", profile: "levels" },
			).kind,
		).toBe("skip");
	});

	test("rejects measurable output regressions", () => {
		const output = { ...input, truePeak: -0.2, lufs: -12, duration: 81 };
		expect(validateAudioQualityMeasurements(input, output, "levels")).toEqual([
			"audio-duration-changed",
			"insufficient-peak-headroom",
			"unexpected-loudness",
			"excessive-gain",
		]);
	});

	test("accepts bounded constant gain without changing duration or dynamics", () => {
		expect(
			validateAudioQualityMeasurements(
				input,
				{ ...input, lufs: -23, truePeak: -4 },
				"levels",
			),
		).toEqual([]);
	});
});
