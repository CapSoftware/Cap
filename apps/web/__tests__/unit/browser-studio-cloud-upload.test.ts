import { describe, expect, it } from "vitest";
import {
	buildBrowserStudioCloudManifest,
	getBrowserStudioManifestSubpath,
} from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/browser-studio-cloud-upload";
import type { BrowserStudioVaultSession } from "@/app/(org)/dashboard/caps/components/web-recorder-dialog/browser-studio-vault";

const session = {
	schemaVersion: 1,
	sessionId: "studio-session",
	videoId: "video-123",
	status: "uploaded",
	createdAt: 100,
	updatedAt: 200,
	browser: {
		userAgent: "Safari",
		platform: "MacIntel",
	},
	project: {
		schemaVersion: 1,
		source: "browser-recorder",
		title: "Browser recording",
		timeline: {
			durationMs: 5000,
			tracks: [
				{
					trackId: "track-screen",
					assetId: "asset-screen",
					kind: "screen",
					label: "Screen recording",
					startMs: 0,
					durationMs: 5000,
					muted: false,
				},
			],
		},
		exportSettings: {
			format: "mp4",
			quality: "source",
		},
	},
	assets: [
		{
			assetId: "asset-screen",
			trackId: "track-screen",
			kind: "screen",
			label: "Screen recording",
			mimeType: "video/mp4",
			fileExtension: "mp4",
			width: 1920,
			height: 1080,
			frameRate: 30,
			sampleRate: null,
			channelCount: 2,
			totalBytes: 12,
			chunkCount: 2,
			chunks: [
				{
					index: 0,
					size: 6,
					checksum:
						"0000000000000000000000000000000000000000000000000000000000000001",
					createdAt: 110,
				},
				{
					index: 1,
					size: 6,
					checksum:
						"0000000000000000000000000000000000000000000000000000000000000002",
					createdAt: 120,
				},
			],
		},
	],
	totalBytes: 12,
	chunkCount: 2,
} satisfies BrowserStudioVaultSession;

describe("browser studio cloud upload", () => {
	it("uses a stable manifest subpath", () => {
		expect(getBrowserStudioManifestSubpath()).toBe("studio/manifest.json");
	});

	it("builds a manifest that references the existing uploaded source", () => {
		const manifest = buildBrowserStudioCloudManifest({
			videoId: "video-123",
			session,
			sourceSubpath: "result.mp4",
			assetSourceSubpaths: {
				"asset-screen": "studio/assets/asset-screen.mp4",
			},
		});

		expect(manifest).toMatchObject({
			schemaVersion: 1,
			videoId: "video-123",
			sessionId: "studio-session",
			source: "browser-studio-vault",
			totalBytes: 12,
			chunkCount: 2,
		});
		expect(manifest.assets).toHaveLength(1);
		expect(manifest.assets[0]?.sourceSubpath).toBe(
			"studio/assets/asset-screen.mp4",
		);
		expect(manifest.assets[0]?.chunks.map((chunk) => chunk.index)).toEqual([
			0, 1,
		]);
		expect(manifest.project.timeline.tracks[0]?.assetId).toBe("asset-screen");
	});
});
