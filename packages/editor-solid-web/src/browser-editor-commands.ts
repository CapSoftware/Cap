import type {
	Audio,
	ProjectRecordingsMeta,
	SegmentRecordings,
	SerializedEditorInstance,
	Video,
} from "../../../apps/desktop/src/utils/tauri";
import type { BrowserEditorMediaMetadata } from "../../../apps/web/lib/browser-editor-metadata";
import { loadBrowserRenderer } from "./browser-renderer";
import {
	BrowserEditorSourceCatalog,
	type BrowserEditorSources,
	type BrowserSourceSegment,
} from "./browser-sources";

type SegmentMedia = {
	display: BrowserEditorMediaMetadata;
	camera: BrowserEditorMediaMetadata | null;
	mic: BrowserEditorMediaMetadata | null;
	systemAudio: BrowserEditorMediaMetadata | null;
};

type BrowserEditorInfo = {
	sources: BrowserEditorSources;
	config: Record<string, unknown>;
	meta: Record<string, unknown>;
	instance: SerializedEditorInstance;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function video(
	media: BrowserEditorMediaMetadata,
	fps: number | null,
	startTime: number,
): Video {
	if (media.width === null || media.height === null) {
		throw new Error("Editor video dimensions are unavailable");
	}
	return {
		duration: media.duration,
		width: media.width,
		height: media.height,
		fps: fps ?? 30,
		start_time: startTime,
	};
}

function audio(
	media: BrowserEditorMediaMetadata | null,
	startTime: number,
): Audio | null {
	if (!media || media.audioChannels === null || media.sampleRate === null) {
		return null;
	}
	return {
		duration: media.duration,
		sample_rate: media.sampleRate,
		channels: media.audioChannels,
		start_time: startTime,
	};
}

function path(index: number, kind: "display" | "camera" | "mic" | "system") {
	return `content/segments/segment-${index}/${kind}.webm`;
}

async function waveform(url: string, signal: AbortSignal) {
	const { ALL_FORMATS, AudioBufferSink, Input, UrlSource } = await import(
		"mediabunny"
	);
	const input = new Input({
		formats: ALL_FORMATS,
		source: new UrlSource(url, { maxCacheSize: 8 * 1024 * 1024 }),
	});
	const cancel = () => input.dispose();
	signal.addEventListener("abort", cancel, { once: true });
	try {
		const track = await input.getPrimaryAudioTrack();
		if (!track) return [];
		const sampleRate = await track.getSampleRate();
		const channels = await track.getNumberOfChannels();
		if (!sampleRate || !channels) return [];
		const blockSamples = Math.max(1, Math.floor(sampleRate / 10) * channels);
		const peaks: number[] = [];
		let sum = 0;
		let count = 0;
		let lastYieldedPeaks = 0;
		for await (const { buffer } of new AudioBufferSink(track).buffers()) {
			if (signal.aborted) throw new Error("Editor waveform was canceled");
			const planes = Array.from(
				{ length: buffer.numberOfChannels },
				(_, index) => buffer.getChannelData(index),
			);
			for (let frame = 0; frame < buffer.length; frame++) {
				for (const plane of planes) {
					sum += Math.abs(plane[frame] ?? 0);
					count++;
				}
				if (count >= blockSamples) {
					const mean = sum / count;
					peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
					sum = 0;
					count = 0;
				}
			}
			if (peaks.length - lastYieldedPeaks >= 500) {
				lastYieldedPeaks = peaks.length;
				await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
			}
		}
		if (count > 0) {
			const mean = sum / count;
			peaks.push(mean > 0 ? 20 * Math.log10(mean) : -60);
		}
		return peaks;
	} finally {
		signal.removeEventListener("abort", cancel);
		input.dispose();
	}
}

export class BrowserEditorCommands {
	static supports(name: string) {
		return [
			"animatedGradientCatalog",
			"randomAnimatedGradient",
			"getMicWaveforms",
			"getSystemAudioWaveforms",
			"getEditorProjectPath",
			"getRecordingMetaByPath",
			"getEditorMeta",
			"createEditorInstance",
			"getVideoMetadata",
			"getDefaultProjectConfig",
			"loadCaptions",
			"setWindowTransparent",
			"tauri:get_recording_recovery_success",
		].includes(name);
	}

	private readonly controller = new AbortController();
	private readonly catalog: BrowserEditorSourceCatalog;
	private pending: Promise<BrowserEditorInfo> | null = null;
	private info: BrowserEditorInfo | null = null;

	constructor(
		private readonly videoId: string,
		private readonly sessionId: string,
	) {
		this.catalog = new BrowserEditorSourceCatalog(videoId);
	}

	private async media(sources: BrowserEditorSources): Promise<SegmentMedia[]> {
		const { probeBrowserEditorMedia } = await import(
			"../../../apps/web/lib/browser-editor-metadata"
		);
		const segments = sources.segments;
		const results = new Array<SegmentMedia>(segments.length);
		let next = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, segments.length) }, async () => {
				while (next < segments.length) {
					const index = next++;
					const segment = segments[index];
					if (!segment?.display) {
						throw new Error("Editor imported recording media is unavailable");
					}
					const [display, camera, mic, systemAudio] = await Promise.all([
						probeBrowserEditorMedia(
							segment.display.url,
							this.controller.signal,
						),
						segment.camera
							? probeBrowserEditorMedia(
									segment.camera.url,
									this.controller.signal,
								)
							: Promise.resolve(null),
						index === 0 && sources.mic
							? probeBrowserEditorMedia(
									sources.mic.url,
									this.controller.signal,
								).catch(() => null)
							: Promise.resolve(null),
						index === 0 && sources.systemAudio
							? probeBrowserEditorMedia(
									sources.systemAudio.url,
									this.controller.signal,
								).catch(() => null)
							: Promise.resolve(null),
					]);
					results[index] = { display, camera, mic, systemAudio };
				}
			}),
		);
		return results;
	}

	private recording(
		segment: BrowserSourceSegment,
		media: SegmentMedia,
	): SegmentRecordings {
		return {
			display: video(media.display, segment.displayFps, 0),
			camera: media.camera
				? video(
						media.camera,
						segment.cameraFps,
						(segment.cameraOffsetMs ?? 0) / 1000,
					)
				: null,
			mic: audio(media.mic, (segment.micOffsetMs ?? 0) / 1000),
			system_audio: audio(
				media.systemAudio,
				(segment.systemAudioOffsetMs ?? 0) / 1000,
			),
		};
	}

	private async load(): Promise<BrowserEditorInfo> {
		const [sources, module] = await Promise.all([
			this.catalog.snapshot(this.controller.signal),
			loadBrowserRenderer(),
		]);
		const media = await this.media(sources);
		const config: unknown =
			sources.projectConfig ?? JSON.parse(module.default_project_config_json());
		const project = record(config);
		if (!project) throw new Error("Editor project configuration is invalid");
		const recordings: ProjectRecordingsMeta = {
			segments: sources.segments.map((segment, index) => {
				const item = media[index];
				if (!item) throw new Error("Editor recording metadata is unavailable");
				return this.recording(segment, item);
			}),
		};
		const recordingDuration = recordings.segments.reduce(
			(total, segment) =>
				total +
				Math.max(
					segment.display.duration,
					segment.camera?.duration ?? 0,
					segment.mic?.duration ?? 0,
				),
			0,
		);
		const editorPath = `cap-web-editor://session/${this.sessionId}`;
		const meta = {
			platform: "MacOS",
			pretty_name: sources.title,
			sharing: {
				id: this.videoId,
				link: new URL(
					`/s/${encodeURIComponent(this.videoId)}`,
					window.location.origin,
				).toString(),
			},
			segments: sources.segments.map((segment, index) => ({
				display: {
					path: path(index, "display"),
					fps: segment.displayFps ?? 30,
					start_time: 0,
				},
				...(segment.camera
					? {
							camera: {
								path: path(index, "camera"),
								fps: segment.cameraFps ?? segment.displayFps ?? 30,
								start_time: (segment.cameraOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
				...(index === 0 && recordings.segments[index]?.mic
					? {
							mic: {
								path: path(index, "mic"),
								start_time: (segment.micOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
				...(index === 0 && recordings.segments[index]?.system_audio
					? {
							system_audio: {
								path: path(index, "system"),
								start_time: (segment.systemAudioOffsetMs ?? 0) / 1000,
							},
						}
					: {}),
			})),
			cursors: {},
			status: { status: "Complete" },
		};
		const instance = {
			instanceId: crypto.randomUUID(),
			preparingPlayback: false,
			preparingSnapshot: null,
			framesSocketUrl: editorPath,
			recordingDuration,
			savedProjectConfig: project,
			recordings,
			path: editorPath,
			notchBase: {
				x: 0.4384920634920635,
				width: 0.12235449735449735,
				height: 0.032586558044806514,
			},
		} as SerializedEditorInstance;
		return { sources, config: project, meta, instance };
	}

	private async snapshot() {
		if (this.controller.signal.aborted) {
			throw new Error("Editor browser session is closed");
		}
		if (this.info) return this.info;
		if (!this.pending) {
			this.pending = this.load().then(
				(info) => {
					this.info = info;
					return info;
				},
				(error: unknown) => {
					this.pending = null;
					throw error;
				},
			);
		}
		return this.pending;
	}

	async invoke(name: string, args: unknown[]): Promise<unknown> {
		if (name === "animatedGradientCatalog") {
			return JSON.parse(
				(await loadBrowserRenderer()).animated_gradient_catalog_json(),
			);
		}
		if (name === "randomAnimatedGradient") {
			const seed = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
			return JSON.parse(
				(await loadBrowserRenderer()).random_animated_gradient_json(seed),
			);
		}
		if (name === "getMicWaveforms" || name === "getSystemAudioWaveforms") {
			const sources = await this.catalog.snapshot(this.controller.signal);
			const tracks: number[][] = sources.segments.map(() => []);
			const source =
				name === "getMicWaveforms"
					? sources.mic
					: (sources.systemAudio ??
						(sources.displayHasAudio ? sources.segments[0]?.display : null));
			if (source) {
				tracks[0] = await waveform(source.url, this.controller.signal).catch(
					() => [],
				);
			}
			return tracks;
		}
		if (name === "getDefaultProjectConfig") {
			return JSON.parse(
				(await loadBrowserRenderer()).default_project_config_json(),
			);
		}
		if (name === "setWindowTransparent") return null;
		if (name === "tauri:get_recording_recovery_success") return false;
		const info = await this.snapshot();
		switch (name) {
			case "getEditorProjectPath":
				return info.instance.path;
			case "getRecordingMetaByPath":
				if (args[0] !== info.instance.path) {
					throw new Error("Editor project path is invalid");
				}
				return info.meta;
			case "getEditorMeta":
				return info.meta;
			case "createEditorInstance":
				return info.instance;
			case "getVideoMetadata": {
				if (args[0] !== info.instance.path) {
					throw new Error("Editor project path is invalid");
				}
				const duration = info.instance.recordings.segments.reduce(
					(total, segment) => total + segment.display.duration,
					0,
				);
				return {
					duration,
					size: duration * (8_192_000 / (8 * 1024 * 1024)),
				};
			}
			case "loadCaptions":
				return info.sources.captionsEnabled
					? (info.config.captions ?? null)
					: null;
			default:
				throw new Error(`Unsupported browser editor command: ${name}`);
		}
	}

	dispose() {
		this.controller.abort();
		this.catalog.dispose();
		this.info = null;
		this.pending = null;
	}
}
