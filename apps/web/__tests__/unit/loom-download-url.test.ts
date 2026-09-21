import { afterEach, describe, expect, it, vi } from "vitest";
import {
	getLoomDownloadUrl,
	getReusableLoomDownloadUrl,
	LoomDownloadTemporaryError,
} from "@/lib/loom-download-url";

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("getLoomDownloadUrl", () => {
	it("honors rate limits without making more endpoint requests", async () => {
		const fetch = vi.fn().mockResolvedValue(
			new Response(null, {
				status: 429,
				headers: { "Retry-After": "120" },
			}),
		);
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomDownloadUrl("video")).rejects.toMatchObject({
			retryAfterMs: 120_000,
		});
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("treats network and server failures as temporary", async () => {
		const fetch = vi.fn().mockRejectedValueOnce(new Error("Timeout"));
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomDownloadUrl("video")).rejects.toBeInstanceOf(
			LoomDownloadTemporaryError,
		);
		fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
		await expect(getLoomDownloadUrl("video")).rejects.toMatchObject({
			retryAfterMs: 60_000,
		});
	});

	it("does not classify an unavailable source as a temporary failure", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValue(new Response(null, { status: 204 }));
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomDownloadUrl("video")).resolves.toBeNull();
		expect(fetch).toHaveBeenCalledTimes(4);
	});

	it("uses an available stream when a later endpoint is rate limited", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({
					url: "https://cdn.loom.com/video.m3u8?Signature=token",
				}),
			)
			.mockResolvedValueOnce(new Response(null, { status: 429 }));
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomDownloadUrl("video")).resolves.toBe(
			"https://cdn.loom.com/video.m3u8?Signature=token",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("prefers a direct file over an earlier stream", async () => {
		const fetch = vi
			.fn()
			.mockResolvedValueOnce(
				Response.json({ url: "https://cdn.loom.com/video.m3u8" }),
			)
			.mockResolvedValueOnce(
				Response.json({ url: "https://cdn.loom.com/original.mp4" }),
			);
		vi.stubGlobal("fetch", fetch);
		await expect(getLoomDownloadUrl("video")).resolves.toBe(
			"https://cdn.loom.com/original.mp4",
		);
	});
});

describe("getReusableLoomDownloadUrl", () => {
	it("reuses a source with enough signed URL lifetime", () => {
		const expires = Math.floor(Date.now() / 1000) + 7200;
		const url = `https://cdn.loom.com/video.m3u8?Expires=${expires}`;
		expect(getReusableLoomDownloadUrl(url)).toBe(url);
		const policy = Buffer.from(
			JSON.stringify({
				Statement: [
					{ Condition: { DateLessThan: { "AWS:EpochTime": expires } } },
				],
			}),
		)
			.toString("base64")
			.replace(/\+/g, "-")
			.replace(/=/g, "_")
			.replace(/\//g, "~");
		const policyUrl = `https://cdn.loom.com/video.m3u8?Policy=${policy}`;
		expect(getReusableLoomDownloadUrl(policyUrl)).toBe(policyUrl);
	});

	it.each([
		undefined,
		"https://cdn.loom.com/video.m3u8?Expires=1",
		"https://cdn.loom.com/video.m3u8?Policy=invalid",
		"https://other.example/video.mp4",
		"http://cdn.loom.com/video.mp4",
		"https://cdn.loom.com/video.m3u8?Signature=unknown",
	])("refreshes stale or unrecognized sources: %s", (url) => {
		expect(getReusableLoomDownloadUrl(url)).toBeNull();
	});
});
