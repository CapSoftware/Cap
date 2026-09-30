import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

import {
	DirectRenderForbidden,
	type DirectRenderInput,
	directRenderLikely,
	parseRenderFarmPrepareSupport,
	planDirectRenderProject,
} from "@/lib/render-farm-direct-plan";
import { buildRenderProject } from "@/lib/render-farm-project";

const OWNER = "owner123456789a";
const VIDEO = "video1234567890";
const root = `${OWNER}/${VIDEO}/`;
const target = { root, recording: `${root}.recording/render/x/project` };
const defaultConfig = {
	audio: { mute: false, improve: false, isolation: "balanced" },
	background: { source: { type: "color", value: [255, 255, 255] } },
	timeline: null,
	clips: [],
};
const support = { version: 1 as const, defaultConfig, music: ["calm-1"] };
const key = (name: string) => `${root}${name}`;

function input(overrides: Partial<DirectRenderInput> = {}): DirectRenderInput {
	return {
		sources: {
			title: "Take",
			display: { contentType: "video/mp4", fps: 30 },
			camera: { contentType: "video/webm", fps: 20, offsetMs: 4 },
			mic: { contentType: "audio/webm", offsetMs: 2 },
		},
		editorSources: {
			version: 1,
			display: {
				key: key("raw-upload.mp4"),
				contentType: "video/mp4",
				size: 10,
				fps: 30,
			},
			camera: {
				key: key("camera-upload.webm"),
				contentType: "video/webm",
				size: 20,
				fps: 20,
				objectIdentity: null,
				offsetMs: 4,
			},
			mic: {
				key: key("mic-upload.webm"),
				contentType: "audio/webm",
				size: 30,
				objectIdentity: null,
				offsetMs: 2,
			},
		},
		heads: new Map([
			[key("raw-upload.mp4"), { size: 10, etag: '"d"' }],
			[key("camera-upload.webm"), { size: 20, etag: '"c"' }],
			[key("mic-upload.webm"), { size: 30, etag: '"m"' }],
		]),
		savedAssets: [],
		ownerId: OWNER,
		videoId: VIDEO,
		hasSavedProject: false,
		defaultStyle: null,
		captionsEnabled: true,
		target,
		support,
		mixedAudioInDisplay: false,
		...overrides,
	};
}

function plan(overrides: Partial<DirectRenderInput> = {}) {
	const result = planDirectRenderProject(input(overrides));
	if ("unsupported" in result) throw new Error(result.unsupported);
	return result;
}

describe("planDirectRenderProject", () => {
	it("names every file where a worker stages it and the farm transcodes it", () => {
		const { prepare, entries } = plan();
		expect(prepare.display).toEqual({
			key: key("raw-upload.mp4"),
			contentType: "video/mp4",
		});
		expect(prepare.sessionDefaults).toBe(true);
		expect(prepare.sources).toMatchObject({
			title: "Take",
			display: {
				path: "content/segments/segment-0/display.h264.mp4",
				fps: 30,
				offsetMs: 0,
			},
			camera: {
				path: "content/segments/segment-0/camera.h264.mp4",
				fps: 20,
				offsetMs: 4,
			},
			mic: { path: "content/segments/segment-0/mic.mic.opus", offsetMs: 2 },
			systemAudio: null,
		});
		expect(entries.map((entry) => entry.path).sort()).toEqual([
			"content/segments/segment-0/camera.h264.mp4",
			"content/segments/segment-0/display.h264.mp4",
			"content/segments/segment-0/mic.mic.opus",
		]);
		expect(
			entries.find((entry) => entry.path.endsWith("display.h264.mp4")),
		).toMatchObject({ transcodeFrom: key("raw-upload.mp4") });
	});

	it("builds the same manifest as a worker-prepared project", () => {
		const direct = plan();
		const worker = buildRenderProject({
			...target,
			files: [
				{
					path: "content/segments/segment-0/display.mp4",
					size: 10,
					inode: "1",
				},
				{
					path: "content/segments/segment-0/camera.webm",
					size: 20,
					inode: "2",
				},
				{ path: "content/segments/segment-0/mic.webm", size: 30, inode: "3" },
				{ path: "recording-meta.json", size: 1, inode: "4" },
				{ path: "project-config.json", size: 1, inode: "5" },
			],
			recordingMeta: {
				segments: [
					{
						display: {
							path: "content/segments/segment-0/display.mp4",
							fps: 30,
						},
						camera: { path: "content/segments/segment-0/camera.webm", fps: 20 },
						mic: { path: "content/segments/segment-0/mic.webm" },
					},
				],
			},
			config: defaultConfig,
			sources: new Map([
				[
					"content/segments/segment-0/display.mp4",
					{ key: key("raw-upload.mp4"), size: 10, identity: '"d"' },
				],
				[
					"content/segments/segment-0/camera.webm",
					{ key: key("camera-upload.webm"), size: 20, identity: '"c"' },
				],
				[
					"content/segments/segment-0/mic.webm",
					{ key: key("mic-upload.webm"), size: 30, identity: '"m"' },
				],
			]),
		});
		expect(worker.uploads).toEqual([]);
		const byPath = (a: { path: string }, b: { path: string }) =>
			a.path.localeCompare(b.path);
		expect([...direct.entries].sort(byPath)).toEqual(
			[...worker.entries].sort(byPath),
		);
	});

	it("opens a never-edited recording with the Studio Sound preference and owner style", () => {
		const { config } = plan({
			sources: {
				...input().sources,
				audioDefault: { enabledByDefault: true, isolation: "strong" },
			},
			defaultStyle: {
				version: 1,
				background: { padding: 0, rounding: 0 },
			},
		});
		expect(config.audio).toEqual({
			mute: false,
			improve: true,
			isolation: "strong",
		});
		expect(config.background).toMatchObject({ padding: 0, rounding: 0 });
		expect(defaultConfig.audio.improve).toBe(false);
	});

	it("keeps a saved project as saved, without the owner style", () => {
		const saved = { ...defaultConfig, aspectRatio: "wide" };
		const { config } = plan({
			sources: { ...input().sources, projectConfig: saved },
			hasSavedProject: true,
			defaultStyle: { version: 1, aspectRatio: "square" },
		});
		expect(config.aspectRatio).toBe("wide");
		expect(
			planDirectRenderProject(
				input({
					sources: { ...input().sources, projectConfig: saved },
					hasSavedProject: true,
				}),
			),
		).toMatchObject({ prepare: { sessionDefaults: false } });
	});

	it("plays mixed display audio from the display, as a worker does", () => {
		const { prepare, entries } = plan({
			sources: {
				title: "Take",
				display: { contentType: "video/webm", fps: 30 },
			},
			editorSources: {
				version: 1,
				display: {
					key: key("raw-upload.webm"),
					contentType: "video/webm",
					size: 10,
				},
			},
			heads: new Map([[key("raw-upload.webm"), { size: 10, etag: '"d"' }]]),
			mixedAudioInDisplay: true,
		});
		expect(prepare.sources.systemAudio).toEqual({
			path: "content/segments/segment-0/display.system.opus",
			offsetMs: 0,
		});
		expect(
			entries.find((entry) => entry.path.endsWith("display.system.opus")),
		).toEqual({
			path: "content/segments/segment-0/display.system.opus",
			key: key("raw-upload.webm"),
			size: 10,
		});
	});

	it("reads MP4 system audio in place as AAC", () => {
		const { prepare } = plan({
			sources: {
				title: "Take",
				display: { contentType: "video/mp4", fps: 30 },
				systemAudio: { contentType: "audio/mp4", offsetMs: -3 },
			},
			editorSources: {
				version: 1,
				display: {
					key: key("raw-upload.mp4"),
					contentType: "video/mp4",
					size: 10,
				},
				systemAudio: {
					key: key("system-audio-upload.mp4"),
					contentType: "audio/mp4",
					size: 5,
					objectIdentity: null,
					offsetMs: -3,
				},
			},
			heads: new Map([
				[key("raw-upload.mp4"), { size: 10, etag: '"d"' }],
				[key("system-audio-upload.mp4"), { size: 5, etag: '"s"' }],
			]),
		});
		expect(prepare.sources.systemAudio).toEqual({
			path: "content/segments/segment-0/system-audio.system.m4a",
			offsetMs: -3,
		});
	});

	it("hands the farm the recording's pointer input", () => {
		const { prepare } = plan({
			sources: { ...input().sources, inputEvents: { url: "https://x" } },
			editorSources: {
				...input().editorSources,
				inputEvents: {
					key: key("input-events-upload.ndjson"),
					contentType: "application/x-ndjson",
					size: 99,
					objectIdentity: null,
				},
			},
		});
		expect(prepare.inputEvents).toEqual({
			key: key("input-events-upload.ndjson"),
			size: 99,
		});
	});

	it("reads saved assets in place and ships wallpapers and library music from the farm", () => {
		const image = {
			path: "content/images/1b0e7a6a-5f52-4b2a-9d3e-2f0a1c0d7e11.png",
			key: key("editor-assets/images/1b0e7a6a-5f52-4b2a-9d3e-2f0a1c0d7e11.png"),
			size: 7,
			objectIdentity: '"i"',
		};
		const { entries, config } = plan({
			sources: {
				...input().sources,
				projectConfig: {
					...defaultConfig,
					background: {
						source: {
							type: "wallpaper",
							path: "cap-web-wallpaper://assets/backgrounds/macOS/sequoia-dark.jpg",
						},
					},
					timeline: {
						audioSegments: [
							{ path: "assets/audio/library-calm-1.mp3" },
							{ path: "assets/audio/library-gone.mp3" },
						],
					},
				},
				imageAssets: [{ path: image.path, size: image.size }],
			},
			hasSavedProject: true,
			savedAssets: [image],
		});
		expect(entries).toContainEqual({
			path: image.path,
			key: image.key,
			size: image.size,
		});
		expect(entries).toContainEqual({
			path: "assets/backgrounds/macOS/sequoia-dark.jpg",
			builtin: "backgrounds/macOS/sequoia-dark.jpg",
		});
		expect(entries).toContainEqual({
			path: "assets/audio/library-calm-1.mp3",
			builtin: "music/calm-1.mp3",
		});
		expect(entries.some((entry) => entry.path.includes("library-gone"))).toBe(
			false,
		);
		expect(config.background).toEqual({
			source: {
				type: "wallpaper",
				path: "$RF_PROJECT/assets/backgrounds/macOS/sequoia-dark.jpg",
			},
		});
	});

	it("refuses captions the plan doesn't include", () => {
		expect(() =>
			planDirectRenderProject(
				input({
					sources: {
						...input().sources,
						projectConfig: {
							...defaultConfig,
							captions: { segments: [{ text: "hi" }] },
						},
					},
					hasSavedProject: true,
					captionsEnabled: false,
				}),
			),
		).toThrow(DirectRenderForbidden);
	});

	it("leaves recordings only a worker can prepare to the worker", () => {
		const unsupported = (overrides: Partial<DirectRenderInput["sources"]>) =>
			planDirectRenderProject(
				input({ sources: { ...input().sources, ...overrides } }),
			);
		expect(unsupported({ legacyEditSpec: { version: 1 } })).toEqual({
			unsupported: "The recording has a legacy edit",
		});
		expect(unsupported({ clips: [] })).toEqual({
			unsupported: "The project has imported clips",
		});
		expect(unsupported({ imports: [] })).toEqual({
			unsupported: "The project has imported clips",
		});
		expect(unsupported({ videoAssets: [] })).toEqual({
			unsupported: "The project has imported clips",
		});
		expect(
			unsupported({ display: { contentType: "video/mp4", fps: 29.97 } }),
		).toEqual({ unsupported: "A source frame rate needs probing" });
		expect(
			unsupported({
				camera: { contentType: "video/mp4", fps: undefined, offsetMs: 0 },
			}),
		).toEqual({ unsupported: "A source frame rate needs probing" });
	});
});

describe("directRenderLikely", () => {
	const editorSources = input().editorSources;
	it("expects a farm-prepared render from stored metadata alone", () => {
		expect(directRenderLikely({ editorSources } as never)).toBe(true);
		expect(directRenderLikely(null)).toBe(false);
		expect(
			directRenderLikely({
				editorSources: {
					...editorSources,
					display: { ...editorSources.display, fps: undefined },
				},
			} as never),
		).toBe(false);
		expect(
			directRenderLikely({
				editorSources,
				webEditorClips: { version: 1, items: [{}] },
			} as never),
		).toBe(false);
	});
});

describe("parseRenderFarmPrepareSupport", () => {
	it("accepts only a complete version 1 capability", () => {
		expect(parseRenderFarmPrepareSupport(support)).toEqual(support);
		expect(parseRenderFarmPrepareSupport(undefined)).toBeNull();
		expect(
			parseRenderFarmPrepareSupport({ ...support, version: 2 }),
		).toBeNull();
		expect(
			parseRenderFarmPrepareSupport({ ...support, music: [1] }),
		).toBeNull();
	});
});
