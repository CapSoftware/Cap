import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getMaxConcurrentProbeOperations,
	registerMediaOperation,
	unregisterMediaOperation,
} from "../../lib/media-operations";
import {
	assertRemotePlaylistStaysOnHost,
	checkVideoAccessible,
	fastestFrameRate,
	isUnreadableMediaInput,
	playlistReferences,
	probeFastestFrameRate,
	probeVideo,
} from "../../lib/media-probe";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO_PATH = join(FIXTURES_DIR, "test-with-audio.mp4");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;
const TEST_VIDEO_NO_AUDIO = `file://${join(FIXTURES_DIR, "test-no-audio.mp4")}`;

async function expectRejected(promise: Promise<unknown>): Promise<void> {
	let rejected = false;
	try {
		await promise;
	} catch {
		rejected = true;
	}
	expect(rejected).toBe(true);
}

describe("mediaProbe integration tests", () => {
	describe("probeVideo", () => {
		test("extracts metadata from video with audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

			expect(metadata).toHaveProperty("duration");
			expect(metadata).toHaveProperty("width");
			expect(metadata).toHaveProperty("height");
			expect(metadata).toHaveProperty("fps");
			expect(metadata).toHaveProperty("videoCodec");
			expect(metadata).toHaveProperty("audioCodec");
			expect(metadata).toHaveProperty("audioChannels");
			expect(metadata).toHaveProperty("sampleRate");
			expect(metadata).toHaveProperty("bitrate");
			expect(metadata).toHaveProperty("fileSize");

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).not.toBeNull();
		});

		test("extracts metadata from video without audio", async () => {
			const metadata = await probeVideo(TEST_VIDEO_NO_AUDIO);

			expect(metadata.duration).toBeGreaterThan(0);
			expect(metadata.width).toBeGreaterThan(0);
			expect(metadata.height).toBeGreaterThan(0);
			expect(metadata.fps).toBeGreaterThan(0);
			expect(metadata.videoCodec).toBeTruthy();
			expect(metadata.audioCodec).toBeNull();
			expect(metadata.audioChannels).toBeNull();
			expect(metadata.sampleRate).toBeNull();
		});

		test("reports the length of a file whose timestamps start an hour in", async () => {
			const metadata = await probeVideo(
				`file://${join(FIXTURES_DIR, "test-offset-start.m2ts")}`,
			);

			expect(metadata.duration).toBeGreaterThan(1.8);
			expect(metadata.duration).toBeLessThan(2.2);
			expect(metadata.width).toBe(64);
		});

		test("throws error for non-existent video", async () => {
			await expectRejected(probeVideo("file:///nonexistent/path/to/video.mp4"));
		});

		test("throws error for invalid URL", async () => {
			await expectRejected(
				probeVideo(
					"https://invalid-domain-that-does-not-exist.example/video.mp4",
				),
			);
		});

		test("rejects missing remote media before starting MediaBunny workers", async () => {
			const server = Bun.serve({
				port: 0,
				fetch() {
					return new Response("Not found", { status: 404 });
				},
			});

			try {
				await expect(probeVideo(`${server.url}missing.mp4`)).rejects.toThrow(
					"Media input is not accessible",
				);
			} finally {
				await server.stop(true);
			}
		});

		function serve(body: string, requests: string[] = []) {
			const data = new TextEncoder().encode(body);
			const slice = (start: number, end: number) =>
				data.buffer.slice(start, end) as ArrayBuffer;
			return Bun.serve({
				port: 0,
				fetch(request) {
					requests.push(new URL(request.url).pathname);
					if (data.length === 0) {
						return new Response(null, { status: 416 });
					}
					const match = request.headers
						.get("range")
						?.match(/^bytes=(\d+)-(\d*)$/);
					if (!match) return new Response(slice(0, data.length));
					const start = Number.parseInt(match[1] ?? "0", 10);
					const end = Math.min(
						match[2] ? Number.parseInt(match[2], 10) : data.length - 1,
						data.length - 1,
					);
					return new Response(slice(start, end + 1), {
						status: 206,
						headers: {
							"Content-Range": `bytes ${start}-${end}/${data.length}`,
						},
					});
				},
			});
		}

		async function unhandledDuring(run: () => Promise<void>) {
			const seen: unknown[] = [];
			const listener = (reason: unknown) => {
				seen.push(reason);
			};
			const events: NodeJS.EventEmitter = process;
			events.on("unhandledRejection", listener);
			try {
				await run();
				await new Promise((resolve) => setTimeout(resolve, 50));
			} finally {
				events.off("unhandledRejection", listener);
			}
			return seen;
		}

		test("refuses a remote playlist without fetching what it lists", async () => {
			const requests: string[] = [];
			const server = serve(
				"#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\nsegment0.ts\n#EXT-X-ENDLIST\n",
				requests,
			);

			try {
				const unhandled = await unhandledDuring(async () => {
					await expect(probeVideo(`${server.url}video`)).rejects.toThrow(
						"the file is a playlist or resource list, not a media file",
					);
				});

				expect(unhandled).toEqual([]);
				expect(requests).toEqual(["/video"]);
			} finally {
				await server.stop(true);
			}
		});

		test("says an empty remote file is empty", async () => {
			const server = serve("");

			try {
				await expect(probeVideo(`${server.url}video`)).rejects.toThrow(
					"Media input is empty",
				);
			} finally {
				await server.stop(true);
			}
		});

		test("refuses a file that is not media without an unhandled rejection", async () => {
			const server = serve("this is a text file renamed to .mp4\n".repeat(200));

			try {
				const unhandled = await unhandledDuring(async () => {
					await expect(probeVideo(`${server.url}video.mp4`)).rejects.toThrow(
						"Media input could not be read",
					);
				});

				expect(unhandled).toEqual([]);
			} finally {
				await server.stop(true);
			}
		});

		test("marks unusable inputs so callers can tell them from server faults", async () => {
			const server = serve("not media at all");

			try {
				const error = await probeVideo(`${server.url}video.mp4`).catch(
					(caught: unknown) => caught,
				);

				expect(isUnreadableMediaInput(error)).toBe(true);
				expect(isUnreadableMediaInput(new Error("Server is busy"))).toBe(false);
			} finally {
				await server.stop(true);
			}
		});

		test("refuses a remote playlist that points at another host, without contacting it", async () => {
			const elsewhere: string[] = [];
			const other = Bun.serve({
				port: 0,
				fetch(request) {
					elsewhere.push(new URL(request.url).pathname);
					return new Response("secret");
				},
			});
			const server = serve(
				[
					"#EXTM3U",
					"#EXT-X-VERSION:3",
					"#EXT-X-TARGETDURATION:4",
					"#EXTINF:4,",
					`${other.url}latest/meta-data/`,
					"#EXT-X-ENDLIST",
					"",
				].join("\n"),
			);

			try {
				const unhandled = await unhandledDuring(async () => {
					await expect(probeVideo(`${server.url}stream.m3u8`)).rejects.toThrow(
						"a remote playlist may only reference files on its own host",
					);
				});

				expect(elsewhere).toEqual([]);
				expect(unhandled).toEqual([]);
			} finally {
				await server.stop(true);
				await other.stop(true);
			}
		});

		test("refuses a playlist whose variant playlist points at another host", async () => {
			const elsewhere: string[] = [];
			const other = Bun.serve({
				port: 0,
				fetch(request) {
					elsewhere.push(new URL(request.url).pathname);
					return new Response("secret");
				},
			});
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					const path = new URL(request.url).pathname;
					if (path === "/master.m3u8") {
						return new Response(
							"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nvariant.m3u8\n",
						);
					}
					return new Response(
						`#EXTM3U\n#EXT-X-MAP:URI="${other.url}init.mp4"\n#EXTINF:4,\nseg.ts\n#EXT-X-ENDLIST\n`,
					);
				},
			});

			try {
				await expect(probeVideo(`${server.url}master.m3u8`)).rejects.toThrow(
					"a remote playlist may only reference files on its own host",
				);
				expect(elsewhere).toEqual([]);
			} finally {
				await server.stop(true);
				await other.stop(true);
			}
		});

		test("stops reading playlists when its time is up", async () => {
			const requests: string[] = [];
			const server = Bun.serve({
				port: 0,
				async fetch(request) {
					const path = new URL(request.url).pathname;
					requests.push(path);
					if (path === "/master.m3u8") {
						return new Response(
							"#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\na.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2\nb.m3u8\n",
						);
					}
					await new Promise((resolve) => setTimeout(resolve, 2_000));
					return new Response("#EXTM3U\n");
				},
			});

			try {
				const started = Date.now();
				await expect(
					assertRemotePlaylistStaysOnHost(`${server.url}master.m3u8`, 200),
				).rejects.toThrow("timed out");
				expect(Date.now() - started).toBeLessThan(1_500);
				await new Promise((resolve) => setTimeout(resolve, 300));
				expect(requests).toEqual(["/master.m3u8", "/a.m3u8"]);
			} finally {
				await server.stop(true);
			}
		});

		test("lists every file a playlist refers to", () => {
			expect(
				playlistReferences(
					[
						"#EXTM3U",
						'#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k"',
						'#EXT-X-MAP:URI="init.mp4",BYTERANGE="800@0"',
						'#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",URI="audio.m3u8"',
						"#EXTINF:4,",
						"seg0.ts",
						"",
						"  https://cdn.example/seg1.ts  ",
					].join("\r\n"),
				),
			).toEqual([
				"https://keys.example/k",
				"init.mp4",
				"audio.m3u8",
				"seg0.ts",
				"https://cdn.example/seg1.ts",
			]);
		});

		test("refuses a redirect to a private address", async () => {
			const server = Bun.serve({
				port: 0,
				fetch() {
					return new Response(null, {
						status: 302,
						headers: {
							Location: "http://169.254.169.254/latest/meta-data/",
						},
					});
				},
			});

			try {
				const started = Date.now();
				await expect(probeVideo(`${server.url}video.mp4`)).rejects.toThrow(
					"redirected to an address that is not allowed",
				);
				expect(Date.now() - started).toBeLessThan(5_000);
			} finally {
				await server.stop(true);
			}
		});

		test("follows a redirect that stays on the same host", async () => {
			const videoData = readFileSync(TEST_VIDEO_WITH_AUDIO_PATH);
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					const url = new URL(request.url);
					if (url.pathname === "/moved.mp4") {
						return new Response(null, {
							status: 302,
							headers: { Location: "/real.mp4" },
						});
					}
					const match = request.headers
						.get("range")
						?.match(/^bytes=(\d+)-(\d*)$/);
					const start = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
					const end = Math.min(
						match?.[2] ? Number.parseInt(match[2], 10) : videoData.length - 1,
						videoData.length - 1,
					);
					return new Response(videoData.subarray(start, end + 1), {
						status: match ? 206 : 200,
						headers: {
							"Accept-Ranges": "bytes",
							"Content-Range": `bytes ${start}-${end}/${videoData.length}`,
							"Content-Type": "video/mp4",
						},
					});
				},
			});

			try {
				const metadata = await probeVideo(`${server.url}moved.mp4`);

				expect(metadata.duration).toBeGreaterThan(0);
				expect(metadata.videoCodec).toBeTruthy();
			} finally {
				await server.stop(true);
			}
		});

		test("probes media when HEAD is forbidden but GET is allowed", async () => {
			const videoData = readFileSync(TEST_VIDEO_WITH_AUDIO_PATH);
			const server = Bun.serve({
				port: 0,
				fetch(request) {
					if (request.method === "HEAD") {
						return new Response(null, { status: 403 });
					}

					const range = request.headers.get("range");
					const match = range?.match(/^bytes=(\d+)-(\d*)$/);
					if (match) {
						const start = Number.parseInt(match[1] ?? "0", 10);
						const end = match[2]
							? Number.parseInt(match[2], 10)
							: videoData.length - 1;
						const chunk = videoData.subarray(start, end + 1);

						return new Response(chunk, {
							status: 206,
							headers: {
								"Accept-Ranges": "bytes",
								"Content-Length": chunk.length.toString(),
								"Content-Range": `bytes ${start}-${end}/${videoData.length}`,
								"Content-Type": "video/mp4",
							},
						});
					}

					return new Response(videoData, {
						headers: {
							"Accept-Ranges": "bytes",
							"Content-Length": videoData.length.toString(),
							"Content-Type": "video/mp4",
						},
					});
				},
			});

			try {
				const metadata = await probeVideo(
					`${server.url}video.mp4?Policy=a&Signature=b`,
				);

				expect(metadata.duration).toBeGreaterThan(0);
				expect(metadata.videoCodec).toBeTruthy();
				expect(metadata.fileSize).toBe(videoData.length);
			} finally {
				await server.stop(true);
			}
		});
	});

	describe("checkVideoAccessible", () => {
		test("returns false for non-existent http URL", async () => {
			const accessible = await checkVideoAccessible(
				"https://invalid-domain-that-does-not-exist.example/video.mp4",
			);
			expect(accessible).toBe(false);
		});
	});
});

describe("mediaProbe metadata accuracy", () => {
	test("returns correct frame rate format", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(typeof metadata.fps).toBe("number");
		expect(metadata.fps).toBeLessThanOrEqual(240);
		expect(metadata.fps % 1).toBeLessThanOrEqual(0.01);
	});

	test("returns reasonable dimensions", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.width).toBeLessThanOrEqual(4096);
		expect(metadata.height).toBeLessThanOrEqual(4096);
		expect(metadata.width).toBeGreaterThan(0);
		expect(metadata.height).toBeGreaterThan(0);
	});

	test("duration matches expected range for test file", async () => {
		const metadata = await probeVideo(TEST_VIDEO_WITH_AUDIO);

		expect(metadata.duration).toBeGreaterThan(0);
		expect(metadata.duration).toBeLessThan(3600);
	});
});

describe("fastest frame rate", () => {
	const steady = (fps: number, frames: number, start = 0) =>
		Array.from({ length: frames }, (_, index) => start + index / fps);

	test("is the rate of a constant frame rate source", () => {
		expect(fastestFrameRate(steady(30, 300))).toBe(30);
		expect(fastestFrameRate(steady(30000 / 1001, 300))).toBe(29.97);
		expect(fastestFrameRate(steady(60, 300))).toBe(60);
		expect(fastestFrameRate(steady(24, 5))).toBe(24);
	});

	test("is the rate of the fast part of a source that starts slowly", () => {
		expect(fastestFrameRate([...steady(2, 40), ...steady(30, 900, 20)])).toBe(
			30,
		);
		expect(fastestFrameRate([...steady(30, 900), ...steady(2, 40, 30)])).toBe(
			30,
		);
	});

	test("sees a burst a quarter of a second long", () => {
		expect(
			fastestFrameRate([
				...steady(5, 50),
				...steady(60, 15, 10),
				...steady(5, 50, 11),
			]),
		).toBe(60);
	});

	test("is not moved by two frames that land close together", () => {
		const paired = steady(30, 300).map(
			(time, index) => time + (index % 2 === 0 ? 0 : -0.012),
		);
		expect(fastestFrameRate(paired)).toBeLessThan(31.5);
	});

	test("reads frames in presentation order", () => {
		const reordered = steady(30, 90);
		for (let index = 1; index + 1 < reordered.length; index += 3) {
			const next = reordered[index + 1] ?? 0;
			reordered[index + 1] = reordered[index] ?? 0;
			reordered[index] = next;
		}
		expect(fastestFrameRate(reordered)).toBe(30);
	});

	test("has no answer for fewer than two frames or repeated timestamps", () => {
		expect(fastestFrameRate([])).toBeNull();
		expect(fastestFrameRate([1])).toBeNull();
		expect(fastestFrameRate([2, 2, 2])).toBeNull();
	});

	test("times every frame of a file, not only its opening", async () => {
		expect(await probeFastestFrameRate(TEST_VIDEO_WITH_AUDIO_PATH)).toBe(
			(await probeVideo(TEST_VIDEO_WITH_AUDIO)).fps,
		);

		const directory = mkdtempSync(join(tmpdir(), "cap-frame-timing-"));
		try {
			const variable = join(directory, "variable.mp4");
			execFileSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=160x90:rate=30:duration=20",
				"-vf",
				"select='if(lt(t,12),not(mod(n,15)),1)'",
				"-fps_mode",
				"vfr",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				"-y",
				variable,
			]);
			expect((await probeVideo(`file://${variable}`)).fps).toBeLessThan(10);
			expect(await probeFastestFrameRate(variable)).toBe(30);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60_000);

	test("leaves a transport stream to the probed rate", async () => {
		expect(
			await probeFastestFrameRate(join(FIXTURES_DIR, "test-offset-start.m2ts")),
		).toBeNull();
	});

	test("does not start when the probe pool is full", async () => {
		const running = Array.from(
			{ length: getMaxConcurrentProbeOperations() },
			() => registerMediaOperation("probe", () => {}),
		);
		try {
			await expect(
				probeFastestFrameRate(TEST_VIDEO_WITH_AUDIO_PATH),
			).rejects.toThrow("Server is busy");
		} finally {
			for (const operation of running) unregisterMediaOperation(operation);
		}
		expect(
			await probeFastestFrameRate(TEST_VIDEO_WITH_AUDIO_PATH),
		).not.toBeNull();
	});

	test("stops when the job is cancelled", async () => {
		const cancelled = new AbortController();
		cancelled.abort();
		await expectRejected(
			probeFastestFrameRate(TEST_VIDEO_WITH_AUDIO_PATH, cancelled.signal),
		);
	});
});
