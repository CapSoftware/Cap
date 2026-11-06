import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAudio } from "../../lib/media-audio";
import { probeVideo } from "../../lib/media-probe";
import { downloadVideoToTemp, generateThumbnail } from "../../lib/media-video";
import { verifyRecording } from "../../lib/recording-verification";

const video = readFileSync(
	join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4"),
);

describe("redirects to a private address", () => {
	const previous = process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS;
	const previousEndpoint = process.env.S3_INTERNAL_ENDPOINT;

	afterEach(() => {
		if (previousEndpoint === undefined) delete process.env.S3_INTERNAL_ENDPOINT;
		else process.env.S3_INTERNAL_ENDPOINT = previousEndpoint;
		if (previous === undefined) {
			delete process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS;
		} else {
			process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = previous;
		}
	});

	function privateRedirectServer() {
		let secretHits = 0;
		let firstHits = 0;
		const server: ReturnType<typeof Bun.serve> = Bun.serve({
			port: 0,
			fetch(request): Response {
				const url = new URL(request.url);
				if (url.pathname === "/secret") {
					secretHits += 1;
					return new Response(video, {
						headers: { "content-type": "video/mp4" },
					});
				}
				firstHits++;
				const destination = new URL("/secret", server.url);
				destination.hostname = "127.0.0.2";
				return new Response(null, {
					status: 302,
					headers: {
						location: destination.toString(),
					},
				});
			},
		});
		process.env.S3_INTERNAL_ENDPOINT = server.url.toString();
		return {
			server,
			firstHits: () => firstHits,
			url: `${server.url}clip.mp4`,
			secretHits: () => secretHits,
		};
	}

	test("probe does not fetch the redirect target", async () => {
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		const target = privateRedirectServer();
		try {
			await expect(probeVideo(target.url)).rejects.toThrow("private address");
			expect(target.firstHits()).toBeGreaterThan(0);
			expect(target.secretHits()).toBe(0);
		} finally {
			target.server.stop(true);
		}
	});

	test("audio extraction does not fetch the redirect target", async () => {
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		const target = privateRedirectServer();
		try {
			await expect(extractAudio(target.url)).rejects.toThrow("private address");
			expect(target.firstHits()).toBeGreaterThan(0);
			expect(target.secretHits()).toBe(0);
		} finally {
			target.server.stop(true);
		}
	});

	test("thumbnail generation does not fetch the redirect target", async () => {
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		const target = privateRedirectServer();
		try {
			await expect(generateThumbnail(target.url, 1)).rejects.toThrow(
				"private address",
			);
			expect(target.firstHits()).toBeGreaterThan(0);
			expect(target.secretHits()).toBe(0);
		} finally {
			target.server.stop(true);
		}
	});

	test("recording verification does not fetch the redirect target", async () => {
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		const target = privateRedirectServer();
		try {
			await expect(
				verifyRecording(target.url, {
					allowObservedDuration: true,
					requireAudio: false,
				}),
			).rejects.toThrow("private address");
			expect(target.firstHits()).toBeGreaterThan(0);
			expect(target.secretHits()).toBe(0);
		} finally {
			target.server.stop(true);
		}
	});
	test("parallel ranged downloads do not fetch the redirect target", async () => {
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		const previousConcurrency = process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY;
		process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY = "4";
		const target = privateRedirectServer();
		try {
			await expect(downloadVideoToTemp(target.url, "mp4")).rejects.toThrow(
				"private address",
			);
			expect(target.firstHits()).toBeGreaterThan(0);
			expect(target.secretHits()).toBe(0);
		} finally {
			if (previousConcurrency === undefined) {
				delete process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY;
			} else {
				process.env.MEDIA_SERVER_DOWNLOAD_CONCURRENCY = previousConcurrency;
			}
			target.server.stop(true);
		}
	});
});
