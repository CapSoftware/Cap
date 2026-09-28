import { expect, test } from "bun:test";
import {
	BrowserAudioLevelAnalyzer,
	initSync,
} from "../renderer/pkg/cap_editor_browser_renderer.js";
import {
	browserAudioLevelSources,
	hasWaveformSegments,
	loadAudioLevels,
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

test("decoded levels reach the renderer and failures are skipped", async () => {
	const applied: Array<[number, string, number]> = [];
	let loaded = 0;
	await loadAudioLevels(
		{ BrowserAudioLevelAnalyzer },
		() => ({
			set_audio_levels: (clip, source, levels) =>
				applied.push([clip, source, levels.length]),
		}),
		[
			{ url: "ok", kind: "mic", segment: 0 },
			{ url: "missing", kind: "system", segment: 0 },
			{ url: "broken", kind: "display", segment: 1 },
		],
		async (url) => {
			if (url === "broken") throw new Error("decode failed");
			return url === "ok" ? new Uint8Array(64) : null;
		},
		() => loaded++,
	);
	expect(applied).toEqual([[0, "mic", 64]]);
	expect(loaded).toBe(1);
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
