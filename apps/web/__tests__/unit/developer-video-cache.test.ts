import { beforeEach, describe, expect, it, vi } from "vitest";

const purge = vi.hoisted(() => vi.fn());
vi.mock("@vercel/functions", () => ({ dangerouslyDeleteByTag: purge }));

const cache = await import("@/lib/developer-video-cache");

beforeEach(() => {
	purge.mockReset();
	purge.mockResolvedValue(undefined);
});

describe("developer playback cache", () => {
	it("tags an answer with its video and its app", () => {
		expect(
			cache.developerPlaybackCacheTags({ id: "video-1", appId: "app-1" }),
		).toBe("infra-video-video-1,infra-app-app-1");
	});

	it("deletes a video's or an app's cached answers at once rather than marking them stale", async () => {
		await cache.purgeDeveloperPlaybackCache({ videoId: "video-1" });
		await cache.purgeDeveloperPlaybackCache({ appId: "app-1" });

		expect(purge.mock.calls).toEqual([
			["infra-video-video-1"],
			["infra-app-app-1"],
		]);
	});

	it("logs a failed purge instead of throwing it", async () => {
		purge.mockRejectedValue(new Error("429"));
		const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

		await expect(
			cache.purgeDeveloperPlaybackCache({ videoId: "video-1" }),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledOnce();
	});
});
