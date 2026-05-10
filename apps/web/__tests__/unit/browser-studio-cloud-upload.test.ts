import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildBrowserStudioCloudManifest,
	getBrowserStudioManifestSubpath,
	uploadBrowserStudioManifest,
	uploadBrowserStudioSourceAssets,
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
	afterEach(() => {
		vi.unstubAllGlobals();
	});

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

	it("uploads the manifest through the server proxy when requested", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ success: true }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const upload = vi.fn();

		const manifest = await uploadBrowserStudioManifest({
			videoId: "video-123",
			session,
			sourceSubpath: "result.mp4",
			upload,
			useServerProxy: true,
		});

		expect(manifest.videoId).toBe("video-123");
		expect(upload).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe(
			"/api/upload/signed/proxy?videoId=video-123&subpath=studio%2Fmanifest.json",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "application/json" },
		});
	});

	it("uploads source assets through the server proxy when requested", async () => {
		const fetchMock = vi.fn(
			async (_input: RequestInfo | URL, _init?: RequestInit) =>
				new Response(JSON.stringify({ success: true }), { status: 200 }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const upload = vi.fn();
		const blob = new Blob(["asset"], { type: "video/mp4" });

		await uploadBrowserStudioSourceAssets({
			videoId: "video-123",
			assets: [
				{
					subpath: "studio/assets/asset-screen.mp4",
					blob,
					fileName: "asset-screen.mp4",
				},
			],
			upload,
			useServerProxy: true,
		});

		expect(upload).not.toHaveBeenCalled();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0]?.[0]?.toString()).toBe(
			"/api/upload/signed/proxy?videoId=video-123&subpath=studio%2Fassets%2Fasset-screen.mp4",
		);
		expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
			method: "POST",
			credentials: "same-origin",
			headers: { "Content-Type": "video/mp4" },
			body: blob,
		});
	});
});
