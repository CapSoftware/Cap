import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

import {
	mapRenderFarmJob,
	renderFarmCallbackUrl,
	renderFarmKeys,
	renderFarmTranscodeKey,
	verifyRenderFarmSignature,
} from "@/lib/render-farm";
import {
	buildRenderProject,
	finishRenderManifest,
	RenderProjectError,
} from "@/lib/render-farm-project";
import { awaitingUnknownRenderJob } from "@/lib/render-farm-status";

describe("render farm callbacks", () => {
	const body = JSON.stringify({ id: "job", status: "ready" });
	const sign = (secret: string) =>
		`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

	it("accepts only the farm's HMAC of the exact body", () => {
		expect(verifyRenderFarmSignature(body, sign("secret"), "secret")).toBe(
			true,
		);
		expect(verifyRenderFarmSignature(body, sign("other"), "secret")).toBe(
			false,
		);
		expect(
			verifyRenderFarmSignature(`${body} `, sign("secret"), "secret"),
		).toBe(false);
		expect(verifyRenderFarmSignature(body, null, "secret")).toBe(false);
		expect(verifyRenderFarmSignature(body, "sha256=zz", "secret")).toBe(false);
	});
});

describe("render farm keys", () => {
	it("keep every export inside the video's render folder", () => {
		expect(renderFarmKeys("owner", "video", "export")).toEqual({
			root: "owner/video/",
			recording: "owner/video/.recording/render/export/project",
			outputKey: "owner/video/.recording/render/export/result.mp4",
			hlsPrefix: "owner/video/.recording/render/export/hls",
		});
	});

	it("reuse a transcode for the same source object and not for a changed one", () => {
		const first = renderFarmTranscodeKey("o/v/", "o/v/raw-upload.webm", "etag");
		expect(first).toMatch(
			/^o\/v\/\.recording\/render\/sources\/[0-9a-f]{32}\.mp4$/,
		);
		expect(renderFarmTranscodeKey("o/v/", "o/v/raw-upload.webm", "etag")).toBe(
			first,
		);
		expect(
			renderFarmTranscodeKey("o/v/", "o/v/raw-upload.webm", "etag-2"),
		).not.toBe(first);
	});
});

describe("mapRenderFarmJob", () => {
	it("reports progress and playability while rendering", () => {
		expect(
			mapRenderFarmJob(
				{
					status: 200,
					body: {
						status: "rendering",
						progress: 0.4,
						hlsSegments: 3,
						hlsUrl: "https://bucket/hls/index.m3u8",
					},
				},
				30,
			),
		).toMatchObject({
			state: "rendering",
			progress: 0.4,
			playable: true,
			hlsUrl: "https://bucket/hls/index.m3u8",
		});
		expect(
			mapRenderFarmJob(
				{ status: 200, body: { status: "planning", hlsSegments: 0 } },
				30,
			),
		).toMatchObject({ state: "rendering", playable: false });
	});

	it("maps a finished job's output and failures", () => {
		expect(
			mapRenderFarmJob(
				{
					status: 200,
					body: {
						status: "ready",
						fps: 30,
						output: { width: 1920, height: 1080, frames: 900, bytes: 1234 },
					},
				},
				60,
			).output,
		).toEqual({ width: 1920, height: 1080, frames: 900, fps: 30, bytes: 1234 });
		expect(
			mapRenderFarmJob(
				{ status: 200, body: { status: "error", error: "x" } },
				30,
			),
		).toMatchObject({ state: "error", error: "x" });
		expect(mapRenderFarmJob({ status: 404, body: null }, 30).state).toBe(
			"gone",
		);
		expect(() => mapRenderFarmJob({ status: 500, body: null }, 30)).toThrow();
	});
});

describe("buildRenderProject", () => {
	const root = "owner/video/";
	const recording = "owner/video/.recording/render/e/project";
	const segment = "content/segments/segment-0";
	const baseFiles = [
		{ path: `${segment}/display.webm`, size: 1000, inode: "1:1" },
		{ path: `${segment}/camera.webm`, size: 500, inode: "1:2" },
		{ path: `${segment}/mic.webm`, size: 200, inode: "1:3" },
		{ path: `${segment}/cursor.json`, size: 50, inode: "1:4" },
		{ path: "content/cursors/web-default.png", size: 9, inode: "1:5" },
		{ path: "recording-meta.json", size: 90, inode: "1:6" },
		{ path: "project-config.json", size: 80, inode: "1:7" },
		{ path: "assets/audio/import-1.ogg", size: 70, inode: "1:8" },
	];
	const meta = {
		segments: [
			{
				display: { path: `${segment}/display.webm`, fps: 30 },
				camera: { path: `${segment}/camera.webm`, fps: 30 },
				mic: { path: `${segment}/mic.webm`, start_time: 0 },
				cursor: `${segment}/cursor.json`,
			},
		],
	};
	const sources = new Map([
		[
			`${segment}/display.webm`,
			{ key: "owner/video/raw-upload.webm", size: 1000, identity: "d" },
		],
		[
			`${segment}/camera.webm`,
			{ key: "owner/video/camera-upload.webm", size: 500, identity: "c" },
		],
		[
			`${segment}/mic.webm`,
			{ key: "owner/video/mic-upload.webm", size: 200, identity: "m" },
		],
		[
			"assets/audio/import-1.ogg",
			{ key: "owner/video/editor-assets/a.ogg", size: 70, identity: "a" },
		],
	]);

	it("transcodes recorded video from its source, reads audio in place and uploads the rest", () => {
		const plan = buildRenderProject({
			root,
			recording,
			files: baseFiles,
			recordingMeta: meta,
			config: {
				background: {
					source: {
						type: "wallpaper",
						path: "cap-web-wallpaper://assets/backgrounds/blue/sky.jpg",
					},
				},
			},
			sources,
		});
		const byPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
		expect(byPath.get(`${segment}/display.h264.mp4`)).toEqual({
			path: `${segment}/display.h264.mp4`,
			key: renderFarmTranscodeKey(root, "owner/video/raw-upload.webm", "d"),
			transcodeFrom: "owner/video/raw-upload.webm",
		});
		expect(byPath.get(`${segment}/mic.mic.opus`)).toEqual({
			path: `${segment}/mic.mic.opus`,
			key: "owner/video/mic-upload.webm",
			size: 200,
		});
		expect(byPath.get("assets/audio/import-1.ogg")?.key).toBe(
			"owner/video/editor-assets/a.ogg",
		);
		expect(byPath.has(`${segment}/display.webm`)).toBe(false);
		expect(byPath.has("recording-meta.json")).toBe(false);
		expect(plan.uploads.sort()).toEqual([
			"content/cursors/web-default.png",
			`${segment}/cursor.json`,
		]);
		expect(plan.wallpapers).toEqual(["blue/sky.jpg"]);
		expect(plan.config.background).toEqual({
			source: {
				type: "wallpaper",
				path: "$RF_PROJECT/assets/backgrounds/blue/sky.jpg",
			},
		});
		const segment0 = (
			plan.recordingMeta.segments as Record<string, unknown>[]
		)[0];
		expect(segment0?.display).toEqual({
			path: `${segment}/display.h264.mp4`,
			fps: 30,
		});
		expect(segment0?.mic).toEqual({
			path: `${segment}/mic.mic.opus`,
			start_time: 0,
		});

		const manifest = finishRenderManifest(
			plan,
			new Map([
				[`${segment}/cursor.json`, 55],
				["content/cursors/web-default.png", 9],
				["assets/backgrounds/blue/sky.jpg", 77],
			]),
			[{ path: "recording-meta.json", size: 10 }],
		);
		const manifestByPath = new Map(
			manifest.files.map((entry) => [entry.path, entry]),
		);
		expect(manifestByPath.get(`${segment}/cursor.json`)).toEqual({
			path: `${segment}/cursor.json`,
			size: 55,
		});
		expect(manifestByPath.get("assets/backgrounds/blue/sky.jpg")?.size).toBe(
			77,
		);
		expect(manifestByPath.get("recording-meta.json")?.size).toBe(10);
	});

	it("maps clip segments to their imported asset through hard links", () => {
		const plan = buildRenderProject({
			root,
			recording,
			files: [
				...baseFiles,
				{ path: "content/videos/clip.webm", size: 300, inode: "9:9" },
				{
					path: "content/segments/segment-1/display.webm",
					size: 300,
					inode: "9:9",
				},
			],
			recordingMeta: {
				segments: [
					...meta.segments,
					{ display: { path: "content/segments/segment-1/display.webm" } },
				],
			},
			config: {},
			sources: new Map([
				...sources,
				[
					"content/videos/clip.webm",
					{
						key: "owner/video/editor-videos/clip.webm",
						size: 300,
						identity: "x",
					},
				],
			]),
		});
		const clip = plan.entries.find(
			(entry) => entry.path === "content/segments/segment-1/display.h264.mp4",
		);
		expect(clip?.transcodeFrom).toBe("owner/video/editor-videos/clip.webm");
		expect(plan.uploads).not.toContain("content/videos/clip.webm");
		expect(plan.uploads).not.toContain(
			"content/segments/segment-1/display.webm",
		);
	});

	it("uploads and transcodes media with no stored source, and splits audio mixed into the display", () => {
		const plan = buildRenderProject({
			root,
			recording,
			files: [
				{ path: `${segment}/display.mp4`, size: 1000, inode: "1:1" },
				{ path: "recording-meta.json", size: 1, inode: "1:6" },
			],
			recordingMeta: {
				segments: [
					{
						display: { path: `${segment}/display.mp4` },
						system_audio: { path: `${segment}/display.mp4` },
					},
				],
			},
			config: {},
			sources: new Map(),
		});
		expect(plan.uploads).toEqual([`${segment}/display.mp4`]);
		const byPath = new Map(plan.entries.map((entry) => [entry.path, entry]));
		expect(byPath.get(`${segment}/display.h264.mp4`)).toEqual({
			path: `${segment}/display.h264.mp4`,
			key: `${recording}/transcoded/${segment}/display.h264.mp4`,
			transcodeFrom: `${recording}/${segment}/display.mp4`,
		});
		expect(byPath.get(`${segment}/display.system.m4a`)).toEqual({
			path: `${segment}/display.system.m4a`,
			key: `${recording}/${segment}/display.mp4`,
			size: 1000,
		});
	});

	it("refuses projects the farm cannot render faithfully", () => {
		const build = (config: unknown, recordingMeta: unknown = meta) =>
			buildRenderProject({
				root,
				recording,
				files: baseFiles,
				recordingMeta,
				config,
				sources,
			});
		expect(() =>
			build({
				timeline: { videoSegments: [{ path: "content/videos/x.mp4" }] },
			}),
		).toThrow(RenderProjectError);
		expect(() =>
			build({
				background: {
					source: { type: "wallpaper", path: "/etc/passwd" },
				},
			}),
		).toThrow(RenderProjectError);
		expect(() => build({}, { display: { path: "x" } })).toThrow(
			RenderProjectError,
		);
		expect(() =>
			buildRenderProject({
				root,
				recording,
				files: baseFiles.filter((file) => !file.path.endsWith("cursor.json")),
				recordingMeta: meta,
				config: {},
				sources,
			}),
		).not.toThrow();
		expect(() => finishRenderManifest(build({}), new Map(), [])).toThrow(
			RenderProjectError,
		);
	});
});

describe("awaitingUnknownRenderJob", () => {
	const startedAt = "2026-09-26T12:00:00.000Z";
	const at = (minutes: number) => Date.parse(startedAt) + minutes * 60_000;

	it("waits while a restarted coordinator may still be reloading the job", () => {
		expect(awaitingUnknownRenderJob({ startedAt }, at(1))).toBe(true);
		expect(awaitingUnknownRenderJob({ startedAt }, at(14))).toBe(true);
	});

	it("gives up on a job the farm still does not know later", () => {
		expect(awaitingUnknownRenderJob({ startedAt }, at(16))).toBe(false);
		expect(awaitingUnknownRenderJob({ startedAt: "not a date" }, at(1))).toBe(
			false,
		);
	});
});

describe("renderFarmCallbackUrl", () => {
	it("adds the protection bypass only for Vercel preview hosts", () => {
		expect(
			renderFarmCallbackUrl("https://cap-web-git-x.vercel.app", "secret"),
		).toBe(
			"https://cap-web-git-x.vercel.app/api/render-farm/callback?x-vercel-protection-bypass=secret",
		);
		expect(renderFarmCallbackUrl("https://cap.so", "secret")).toBe(
			"https://cap.so/api/render-farm/callback",
		);
		expect(renderFarmCallbackUrl("https://cap-web.vercel.app", undefined)).toBe(
			"https://cap-web.vercel.app/api/render-farm/callback",
		);
	});
});
