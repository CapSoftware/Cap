import type { VideoMetadata } from "@cap/database/types";
import { describe, expect, test, vi } from "vitest";
import { renderFarmKeys } from "@/lib/render-farm";
import {
	renderFarmJobRequest,
	shareRenderSettings,
} from "@/lib/render-farm-start";
import { shareRenderFps } from "@/lib/share-render";

vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));

const editorSources = (
	displayFps: number | undefined,
	cameraFps?: number,
): VideoMetadata => ({
	editorSources: {
		version: 1,
		display: {
			key: "owner/video/raw-upload.mp4",
			contentType: "video/mp4",
			...(displayFps === undefined ? {} : { fps: displayFps }),
		},
		...(cameraFps === undefined
			? {}
			: {
					camera: {
						key: "owner/video/camera-upload.mp4",
						contentType: "video/mp4" as const,
						size: 1,
						fps: cameraFps,
						objectIdentity: null,
						offsetMs: 0,
					},
				}),
	},
});

describe("shareRenderFps", () => {
	test("picks the desktop export's rate for the recorded rate", () => {
		expect(
			[1, 10, 14, 15, 16, 17, 20, 24, 25, 27, 30, 50, 54, 55, 59, 60, 120].map(
				(fps) => [fps, shareRenderFps(fps)],
			),
		).toEqual([
			[1, 15],
			[10, 15],
			[14, 15],
			[15, 15],
			[16, 15],
			[17, 30],
			[20, 30],
			[24, 30],
			[25, 30],
			[27, 30],
			[30, 30],
			[50, 60],
			[54, 60],
			[55, 60],
			[59, 60],
			[60, 60],
			[120, 60],
		]);
	});

	test("follows the faster of the screen and camera", () => {
		expect(shareRenderFps(15, 30)).toBe(30);
		expect(shareRenderFps(60, 20)).toBe(60);
		expect(shareRenderFps(20, null)).toBe(30);
	});

	test("renders an unknown rate at 30 fps", () => {
		expect(shareRenderFps(null)).toBe(30);
		expect(shareRenderFps(undefined, undefined)).toBe(30);
		expect(shareRenderFps(0)).toBe(30);
		expect(shareRenderFps(Number.NaN)).toBe(30);
	});
});

describe("shareRenderSettings", () => {
	test("renders share links at 1080p with the desktop Link compression", () => {
		expect(
			shareRenderSettings({ fps: 30, metadata: editorSources(30) }),
		).toEqual({ resolution: [1920, 1080], fps: 30, compression: "Social" });
	});

	test("takes the rate from the recorded sources, not the row a render rewrote", () => {
		const metadata = editorSources(20);
		const recorded = shareRenderSettings({ fps: null, metadata });
		const afterRender = shareRenderSettings({ fps: 30, metadata });
		const afterUpload = shareRenderSettings({ fps: 20, metadata });
		const afterBrowserSave = shareRenderSettings({ fps: 24, metadata });
		expect(
			[recorded, afterRender, afterUpload, afterBrowserSave].map(
				(settings) => settings.fps,
			),
		).toEqual([30, 30, 30, 30]);
	});

	test("counts the camera's rate", () => {
		expect(
			shareRenderSettings({ fps: 15, metadata: editorSources(15, 30) }).fps,
		).toBe(30);
	});

	test("falls back to the row's rate only without a recorded one", () => {
		expect(
			shareRenderSettings({ fps: 60, metadata: editorSources(undefined) }).fps,
		).toBe(60);
		expect(shareRenderSettings({ fps: null, metadata: null }).fps).toBe(30);
	});
});

test("the farm job asks for the share render settings", () => {
	const target = renderFarmKeys("owner", "video", "export");
	const settings = shareRenderSettings({
		fps: 24,
		metadata: editorSources(20),
	});
	expect(
		renderFarmJobRequest({
			target,
			callbackUrl: "https://cap.so/api/render-farm/callback",
			reference: "recording:video",
			settings,
		}),
	).toEqual({
		recording: "owner/video/.recording/render/export/project",
		sourceRoot: "owner/video/",
		output: {
			key: "owner/video/.recording/outputs/render-export/result.mp4",
			hlsPrefix: "owner/video/.recording/render/export/hls",
		},
		callbackUrl: "https://cap.so/api/render-farm/callback",
		reference: "recording:video",
		resolution: [1920, 1080],
		fps: 30,
		compression: "Social",
		prepare: "prepare.json",
	});
});
