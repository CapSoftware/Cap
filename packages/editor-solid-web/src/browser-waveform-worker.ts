import {
	ALL_FORMATS,
	AudioSampleSink,
	Input,
	ReadableStreamSource,
} from "mediabunny";

type WaveformRequest = { url: string };
type WaveformResponse = { peaks: number[] } | { error: string };

const scope = self as unknown as {
	addEventListener: (
		type: "message",
		listener: (event: MessageEvent<WaveformRequest>) => void,
	) => void;
	postMessage: (message: WaveformResponse) => void;
};

/// Mean absolute level in dB for every tenth of a second of the track,
/// decoded off the main thread so long recordings don't stall the editor.
/// The file streams through once: ranged reads ahead of a decoder this slow
/// get dropped and fetched again, several times the file for long audio.
async function waveform(url: string) {
	const response = await fetch(url);
	if (!response.ok || !response.body) {
		throw new Error("Editor waveform audio could not load");
	}
	const input = new Input({
		formats: ALL_FORMATS,
		source: new ReadableStreamSource(response.body),
	});
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return [];
		const sampleRate = await track.getSampleRate();
		const channels = await track.getNumberOfChannels();
		if (!sampleRate || !channels) return [];
		const blockSamples = Math.max(1, Math.floor(sampleRate / 10) * channels);
		const peaks: number[] = [];
		let plane = new Float32Array(0);
		let sum = 0;
		let count = 0;
		for await (const sample of new AudioSampleSink(track).samples()) {
			const frames = sample.numberOfFrames;
			if (plane.length < frames) plane = new Float32Array(frames);
			const sums = new Float64Array(frames);
			for (let channel = 0; channel < sample.numberOfChannels; channel++) {
				sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
				for (let frame = 0; frame < frames; frame++) {
					sums[frame] = (sums[frame] ?? 0) + Math.abs(plane[frame] ?? 0);
				}
			}
			sample.close();
			for (let frame = 0; frame < frames; frame++) {
				sum += sums[frame] ?? 0;
				count += channels;
				if (count >= blockSamples) {
					const mean = sum / count;
					peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
					sum = 0;
					count = 0;
				}
			}
		}
		if (count > 0) {
			const mean = sum / count;
			peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
		}
		return peaks;
	} finally {
		input.dispose();
	}
}

scope.addEventListener("message", (event) => {
	void waveform(event.data.url).then(
		(peaks) => scope.postMessage({ peaks }),
		(error: unknown) =>
			scope.postMessage({
				error: error instanceof Error ? error.message : String(error),
			}),
	);
});
