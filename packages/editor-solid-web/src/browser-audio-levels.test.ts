import { expect, test } from "bun:test";
import {
	BrowserAudioLevelAnalyzer,
	initSync,
} from "../renderer/pkg/cap_editor_browser_renderer.js";
import {
	audioLevelSourceKey,
	browserAudioLevelSources,
	hasWaveformSegments,
	loadAudioLevels,
	timelineAudioLevelSources,
} from "./browser-audio-levels";
import type { BrowserEditorSources } from "./browser-sources";

const video = (name: string) => ({
	url: `https://media.example.com/${name}.webm`,
	expiresAt: 0,
});

function sources(
	overrides: Partial<BrowserEditorSources> = {},
): BrowserEditorSources {
	const segment = {
		display: video("display"),
		camera: null,
		displayFps: 30,
		cameraFps: null,
		cameraOffsetMs: null,
		micOffsetMs: null,
		systemAudioOffsetMs: null,
		duration: 4,
		hasAudio: false,
	};
	return {
		videoId: "recording",
		title: "Recording",
		captionsEnabled: false,
		projectConfig: null,
		defaultStyle: null,
		displayHasAudio: false,
		audioOnly: false,
		mic: null,
		systemAudio: null,
		inputEvents: null,
		segments: [segment, { ...segment, display: video("clip"), hasAudio: true }],
		expiresAt: 0,
		...overrides,
	};
}

test("waveform segments are detected from the project timeline", () => {
	expect(hasWaveformSegments(null)).toBe(false);
	expect(hasWaveformSegments({ timeline: { waveformSegments: [] } })).toBe(
		false,
	);
	expect(
		hasWaveformSegments({ timeline: { waveformSegments: [{ start: 0 }] } }),
	).toBe(true);
});

test("level sources follow the tracks playback hears", () => {
	expect(browserAudioLevelSources(sources())).toEqual([
		{ url: video("clip").url, kind: "display", segment: 1 },
	]);
	expect(
		browserAudioLevelSources(
			sources({
				displayHasAudio: true,
				mic: { ...video("mic"), offsetMs: 0 },
				systemAudio: { ...video("system"), offsetMs: 0 },
			}),
		),
	).toEqual([
		{ url: video("mic").url, kind: "mic", segment: 0 },
		{ url: video("system").url, kind: "system", segment: 0 },
		{ url: video("display").url, kind: "display", segment: 0 },
		{ url: video("clip").url, kind: "display", segment: 1 },
	]);
});

test("timeline audio sources skip muted, disabled and unresolved files", () => {
	const config = {
		timeline: {
			audioSegments: [
				{ path: "music.mp3", start: 4, end: 8, trimStart: 2 },
				{ path: "music.mp3", start: 10, end: 12 },
				{ path: "voice.m4a", start: 0, end: 2, volumeDb: -6 },
				{ path: "muted.mp3", start: 0, end: 2, volumeDb: -60 },
				{ path: "off.mp3", start: 0, end: 2, enabled: false },
				{ path: "unknown.mp3", start: 0, end: 2 },
				{ start: 0, end: 2 },
			],
		},
	};
	const urls: Record<string, string> = {
		"music.mp3": "https://assets.example.com/music.mp3",
		"voice.m4a": "https://assets.example.com/voice.m4a",
		"muted.mp3": "https://assets.example.com/muted.mp3",
		"off.mp3": "https://assets.example.com/off.mp3",
	};
	const sources = timelineAudioLevelSources(config, (path) => urls[path]);
	expect(sources).toEqual([
		{ url: urls["music.mp3"] ?? "", kind: "timeline", path: "music.mp3" },
		{ url: urls["voice.m4a"] ?? "", kind: "timeline", path: "voice.m4a" },
	]);
	expect(timelineAudioLevelSources({}, () => "unused")).toEqual([]);
	expect(sources.map(audioLevelSourceKey)).toEqual([
		`timeline:music.mp3:${urls["music.mp3"]}`,
		`timeline:voice.m4a:${urls["voice.m4a"]}`,
	]);
	expect(audioLevelSourceKey({ url: "mic", kind: "mic", segment: 0 })).toBe(
		"mic:0",
	);
});

test("decoded levels reach the renderer and failed decodes are reported for a retry", async () => {
	const applied: Array<[number | string, string, number]> = [];
	let loaded = 0;
	const failed = await loadAudioLevels(
		{ BrowserAudioLevelAnalyzer },
		() => ({
			set_audio_levels: (clip, source, levels) =>
				applied.push([clip, source, levels.length]),
			set_timeline_audio_levels: (path, levels) =>
				applied.push([path, "timeline", levels.length]),
		}),
		[
			{ url: "ok", kind: "mic", segment: 0 },
			{ url: "missing", kind: "system", segment: 0 },
			{ url: "broken", kind: "display", segment: 1 },
			{ url: "ok", kind: "timeline", path: "music.mp3" },
		],
		async (url) => {
			if (url === "broken") throw new Error("decode failed");
			return url === "ok" ? new Uint8Array(64) : null;
		},
		() => loaded++,
	);
	expect(applied).toEqual([
		[0, "mic", 64],
		["music.mp3", "timeline", 64],
	]);
	expect(loaded).toBe(2);
	expect(failed).toEqual([{ url: "broken", kind: "display", segment: 1 }]);
});

test("the wasm analyzer turns PCM into 60 Hz frames of 32 bands", async () => {
	const wasm = await Bun.file(
		new URL(
			"../renderer/pkg/cap_editor_browser_renderer_bg.wasm",
			import.meta.url,
		),
	).arrayBuffer();
	initSync({ module: wasm });
	const sampleRate = 48_000;
	const analyzer = new BrowserAudioLevelAnalyzer(sampleRate);
	const samples = new Float32Array(sampleRate);
	for (let index = 0; index < samples.length; index++) {
		samples[index] = 0.5 * Math.sin((2 * Math.PI * 440 * index) / sampleRate);
	}
	analyzer.push(samples.subarray(0, 1000));
	analyzer.push(samples.subarray(1000));
	const levels = analyzer.finish();
	expect(levels.length).toBe(60 * 32);
	expect(Math.max(...levels.subarray(30 * 32, 31 * 32))).toBeGreaterThan(200);
	expect(() => new BrowserAudioLevelAnalyzer(0)).toThrow();
});
