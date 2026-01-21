export interface WaveformData {
	peaks: Float32Array;
	duration: number;
	sampleRate: number;
}

export interface WaveformOptions {
	samplesPerSecond?: number;
	channel?: number;
}

const DEFAULT_SAMPLES_PER_SECOND = 100;

export async function generateWaveformFromUrl(
	url: string,
	options: WaveformOptions = {},
): Promise<WaveformData> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`Failed to fetch audio: ${response.status}`);
	}
	const arrayBuffer = await response.arrayBuffer();
	return generateWaveformFromArrayBuffer(arrayBuffer, options);
}

export async function generateWaveformFromArrayBuffer(
	arrayBuffer: ArrayBuffer,
	options: WaveformOptions = {},
): Promise<WaveformData> {
	const audioContext = new AudioContext();
	try {
		const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
		return generateWaveformFromAudioBuffer(audioBuffer, options);
	} finally {
		await audioContext.close();
	}
}

export function generateWaveformFromAudioBuffer(
	audioBuffer: AudioBuffer,
	options: WaveformOptions = {},
): WaveformData {
	const { samplesPerSecond = DEFAULT_SAMPLES_PER_SECOND, channel = 0 } =
		options;

	const channelData = audioBuffer.getChannelData(
		Math.min(channel, audioBuffer.numberOfChannels - 1),
	);
	const duration = audioBuffer.duration;
	const totalSamples = Math.ceil(duration * samplesPerSecond);
	const samplesPerPeak = Math.floor(channelData.length / totalSamples);

	const peaks = new Float32Array(totalSamples);

	for (let i = 0; i < totalSamples; i++) {
		const start = i * samplesPerPeak;
		const end = Math.min(start + samplesPerPeak, channelData.length);

		let max = 0;
		for (let j = start; j < end; j++) {
			const abs = Math.abs(channelData[j]);
			if (abs > max) max = abs;
		}
		peaks[i] = max;
	}

	return {
		peaks,
		duration,
		sampleRate: samplesPerSecond,
	};
}

export function normalizePeaks(peaks: Float32Array): Float32Array {
	const max = peaks.reduce((m, v) => Math.max(m, v), 0);
	if (max === 0) return peaks;

	const normalized = new Float32Array(peaks.length);
	for (let i = 0; i < peaks.length; i++) {
		normalized[i] = peaks[i] / max;
	}
	return normalized;
}

export function resamplePeaks(
	peaks: Float32Array,
	targetLength: number,
): Float32Array {
	if (peaks.length === targetLength) return peaks;

	const result = new Float32Array(targetLength);
	const ratio = peaks.length / targetLength;

	for (let i = 0; i < targetLength; i++) {
		const start = Math.floor(i * ratio);
		const end = Math.min(Math.ceil((i + 1) * ratio), peaks.length);

		let max = 0;
		for (let j = start; j < end; j++) {
			if (peaks[j] > max) max = peaks[j];
		}
		result[i] = max;
	}

	return result;
}

export function getPeaksInRange(
	waveform: WaveformData,
	startTime: number,
	endTime: number,
	targetSamples: number,
): Float32Array {
	const startIndex = Math.floor(startTime * waveform.sampleRate);
	const endIndex = Math.ceil(endTime * waveform.sampleRate);
	const sliced = waveform.peaks.slice(
		Math.max(0, startIndex),
		Math.min(waveform.peaks.length, endIndex),
	);

	return resamplePeaks(sliced, targetSamples);
}
