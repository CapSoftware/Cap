import type { BrowserEditorSources } from "./browser-sources";

export type BrowserAudioLevelSource = {
	url: string;
	kind: "mic" | "system" | "display";
	segment: number;
};

type LevelAnalyzer = {
	push(samples: Float32Array): void;
	finish(): Uint8Array;
	free(): void;
};

export type AudioLevelModule = {
	BrowserAudioLevelAnalyzer: new (sampleRate: number) => LevelAnalyzer;
};

export type AudioLevelTarget = {
	set_audio_levels(
		recordingClip: number,
		source: string,
		levels: Uint8Array,
	): void;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export function hasWaveformSegments(config: unknown) {
	const segments = record(record(config)?.timeline)?.waveformSegments;
	return Array.isArray(segments) && segments.length > 0;
}

export function browserAudioLevelSources(
	sources: BrowserEditorSources,
): BrowserAudioLevelSource[] {
	const audio: BrowserAudioLevelSource[] = [];
	if (sources.mic)
		audio.push({ url: sources.mic.url, kind: "mic", segment: 0 });
	if (sources.systemAudio)
		audio.push({ url: sources.systemAudio.url, kind: "system", segment: 0 });
	sources.segments.forEach((segment, index) => {
		const embedded = index === 0 ? sources.displayHasAudio : segment.hasAudio;
		if (embedded && segment.display)
			audio.push({ url: segment.display.url, kind: "display", segment: index });
	});
	return audio;
}

/// Decodes a file's primary audio track and analyses it into the renderer's
/// waveform band levels, one decoded sample at a time. Uses `AudioSample`
/// rather than `AudioBuffer`, which workers such as the export's lack.
export async function decodeAudioLevels(
	module: AudioLevelModule,
	url: string,
	signal?: AbortSignal,
): Promise<Uint8Array | null> {
	const { ALL_FORMATS, AudioSampleSink, Input, UrlSource } = await import(
		"mediabunny"
	);
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, { maxCacheSize: 8 * 1024 * 1024 }),
	});
	const cancel = () => input.dispose();
	signal?.addEventListener("abort", cancel, { once: true });
	let analyzer: LevelAnalyzer | null = null;
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return null;
		let mono = new Float32Array(0);
		let plane = new Float32Array(0);
		let sinceYield = 0;
		for await (const sample of new AudioSampleSink(track).samples()) {
			try {
				if (signal?.aborted)
					throw new Error("Editor audio levels were canceled");
				analyzer ??= new module.BrowserAudioLevelAnalyzer(sample.sampleRate);
				const frames = sample.numberOfFrames;
				if (mono.length !== frames) {
					mono = new Float32Array(frames);
					plane = new Float32Array(frames);
				} else mono.fill(0);
				const scale = 1 / sample.numberOfChannels;
				for (let channel = 0; channel < sample.numberOfChannels; channel++) {
					sample.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
					for (let frame = 0; frame < frames; frame++) {
						mono[frame] = (mono[frame] ?? 0) + (plane[frame] ?? 0) * scale;
					}
				}
				analyzer.push(mono);
				sinceYield += sample.duration;
			} finally {
				sample.close();
			}
			if (sinceYield >= 30) {
				sinceYield = 0;
				await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
		}
		if (!analyzer) return null;
		const levels = analyzer.finish();
		analyzer = null;
		return levels;
	} finally {
		analyzer?.free();
		signal?.removeEventListener("abort", cancel);
		input.dispose();
	}
}

/// Loads every source's levels into `target`, calling `onLoaded` after each
/// one lands. A source that fails to decode is skipped.
export async function loadAudioLevels(
	module: AudioLevelModule,
	target: () => AudioLevelTarget | null,
	sources: BrowserAudioLevelSource[],
	decode: (url: string) => Promise<Uint8Array | null> = (url) =>
		decodeAudioLevels(module, url),
	onLoaded: () => void = () => undefined,
) {
	await Promise.all(
		sources.map(async (source) => {
			const levels = await decode(source.url).catch(() => null);
			const renderer = target();
			if (!levels || !renderer) return;
			renderer.set_audio_levels(source.segment, source.kind, levels);
			onLoaded();
		}),
	);
}
