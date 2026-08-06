import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	extractLoomVideoId,
	resolveLoomBrowserDownload,
} from "@/lib/loom-browser-download";

describe("loom-browser-download", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("extracts Loom share IDs without loading the share page", () => {
		expect(
			extractLoomVideoId(
				"https://www.loom.com/share/05f424bf8781404091f365c9f5231d86",
			),
		).toBe("05f424bf8781404091f365c9f5231d86");
		expect(extractLoomVideoId("https://example.com/share/not-loom")).toBeNull();
	});

	it("resolves direct MP4 downloads in the browser", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = input.toString();

			if (url.includes("/transcoded-url")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({ url: "https://cdn.loom.com/video.mp4" }),
				} as Response;
			}

			if (url === "https://www.loom.com/graphql") {
				return {
					ok: true,
					json: async () => ({
						data: { getVideo: { name: "Direct download" } },
					}),
				} as Response;
			}

			if (url.includes("/v1/oembed")) {
				return {
					ok: true,
					json: async () => ({ duration: 42, width: 1920, height: 1080 }),
				} as Response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});

		await expect(
			resolveLoomBrowserDownload(
				"https://www.loom.com/share/05f424bf8781404091f365c9f5231d86",
			),
		).resolves.toEqual({
			success: true,
			videoId: "05f424bf8781404091f365c9f5231d86",
			videoName: "Direct download",
			downloadUrl: "https://cdn.loom.com/video.mp4",
			downloadMode: "direct-download",
			durationSeconds: 42,
			width: 1920,
			height: 1080,
		});
		expect(
			fetchMock.mock.calls.some(([input]) =>
				input.toString().startsWith("https://www.loom.com/share/"),
			),
		).toBe(false);
	});

	it("keeps DASH manifests on the browser conversion path", async () => {
		const fetchMock = vi.mocked(fetch);
		fetchMock.mockImplementation(async (input) => {
			const url = input.toString();

			if (url.includes("/transcoded-url")) {
				return {
					ok: false,
					status: 204,
					text: async () => "",
				} as Response;
			}

			if (url.includes("/raw-url")) {
				return {
					ok: true,
					status: 200,
					text: async () =>
						JSON.stringify({
							url: "https://luna.loom.com/id/video/resource/dash/playlistmultibitrate.mpd?Policy=abc",
						}),
				} as Response;
			}

			if (url === "https://www.loom.com/graphql") {
				return {
					ok: true,
					json: async () => ({
						data: { getVideo: { name: "DASH download" } },
					}),
				} as Response;
			}

			if (url.includes("/v1/oembed")) {
				return {
					ok: true,
					json: async () => ({ duration: 20, width: 1280, height: 720 }),
				} as Response;
			}

			throw new Error(`Unexpected fetch: ${url}`);
		});

		await expect(
			resolveLoomBrowserDownload(
				"https://www.loom.com/share/05f424bf8781404091f365c9f5231d86",
			),
		).resolves.toMatchObject({
			success: true,
			downloadMode: "browser-conversion",
			downloadUrl:
				"https://luna.loom.com/id/video/resource/dash/playlistmultibitrate.mpd?Policy=abc",
		});
	});
});
