export interface AudioQualityMeasurements {
	lufs: number;
	truePeak: number;
	lra: number;
	duration: number;
	channels: number;
	sampleRate: number;
	sampleCount: number;
}

export type AudioQualityProfile = "levels" | "voice";

export type AudioQualityPlan =
	| { kind: "skip"; reason: string }
	| {
			kind: "candidate";
			profile: AudioQualityProfile;
			version: "audio-quality-v3";
			filter: string;
			gainDb: number;
	  };

function levelGainDb(measurements: AudioQualityMeasurements): number {
	return Math.min(
		28,
		Math.max(12, -22 - measurements.lufs),
		-16 - measurements.lufs,
		-2 - measurements.truePeak,
	);
}

export function planAudioQuality(
	measurements: AudioQualityMeasurements,
	options: {
		mode: "off" | "shadow";
		profile: AudioQualityProfile;
		speechOnlyConfirmed?: boolean;
	},
): AudioQualityPlan {
	if (options.mode !== "shadow") return { kind: "skip", reason: "disabled" };
	if (
		!Object.values(measurements).every(Number.isFinite) ||
		measurements.lufs < (options.profile === "levels" ? -55 : -50) ||
		measurements.lufs > 0 ||
		measurements.lra < 0 ||
		measurements.lra > 50 ||
		measurements.truePeak < -100 ||
		measurements.truePeak > 0
	)
		return { kind: "skip", reason: "unsafe-levels" };
	if (
		measurements.duration < 3 ||
		measurements.duration > 3600 ||
		!Number.isSafeInteger(measurements.sampleCount) ||
		measurements.sampleCount < 1 ||
		![1, 2].includes(measurements.channels) ||
		![44100, 48000].includes(measurements.sampleRate)
	)
		return { kind: "skip", reason: "unsupported-format" };
	if (measurements.lufs >= -18) return { kind: "skip", reason: "already-loud" };
	if (options.profile === "voice" && !options.speechOnlyConfirmed)
		return { kind: "skip", reason: "unconfirmed-speech-only" };
	const gainDb = levelGainDb(measurements);
	if (options.profile === "levels" && gainDb < 1)
		return { kind: "skip", reason: "insufficient-headroom" };
	const preGain = Math.min(18, Math.max(0, -20 - measurements.lufs));
	const targetLufs = Math.min(-16, measurements.lufs + 18);
	// afftdn delays content by two sample-advance blocks without compensating PTS.
	const denoiseDelay = 2 * Math.floor(measurements.sampleRate / 80);
	return {
		kind: "candidate",
		profile: options.profile,
		version: "audio-quality-v3",
		gainDb: options.profile === "levels" ? gainDb : preGain,
		filter:
			options.profile === "levels"
				? `volume=${gainDb.toFixed(6)}dB`
				: [
						`volume=${preGain.toFixed(6)}dB`,
						"highpass=f=60",
						"equalizer=f=250:t=q:w=0.8:g=-0.75",
						"equalizer=f=2500:t=q:w=0.7:g=0.75",
						`apad=pad_len=${denoiseDelay}`,
						"afftdn=nr=6:nf=-45:tn=1:gs=5",
						`atrim=start_sample=${denoiseDelay}:end_sample=${measurements.sampleCount + denoiseDelay}`,
						"asetpts=N/SR/TB",
						`loudnorm=I=${targetLufs.toFixed(2)}:TP=-2:LRA=11:dual_mono=true`,
					].join(","),
	};
}

export function validateAudioQualityMeasurements(
	input: AudioQualityMeasurements,
	output: AudioQualityMeasurements,
	profile: AudioQualityProfile,
): string[] {
	const failures: string[] = [];
	if (!Object.values(output).every(Number.isFinite))
		return ["invalid-output-measurements"];
	if (input.channels !== output.channels)
		failures.push("channel-count-changed");
	if (input.sampleRate !== output.sampleRate)
		failures.push("sample-rate-changed");
	if (Math.abs(input.duration - output.duration) > 0.025)
		failures.push("audio-duration-changed");
	if (
		output.sampleCount < input.sampleCount ||
		output.sampleCount - input.sampleCount >= 1024
	)
		failures.push("decoded-sample-count-changed");
	if (output.truePeak > -1) failures.push("insufficient-peak-headroom");
	if (output.lufs < input.lufs - 0.5 || output.lufs > -14)
		failures.push("unexpected-loudness");
	const maximumGain = profile === "levels" ? levelGainDb(input) : 18;
	if (output.lufs - input.lufs > maximumGain + 0.75)
		failures.push("excessive-gain");
	if (profile === "levels" && Math.abs(output.lra - input.lra) > 1)
		failures.push("dynamics-changed");
	return failures;
}
