import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withTimeout } from "../../lib/media-common";
import { probeVideo } from "../../lib/media-probe";
import {
	buildStreamingDownloadFfmpegArgs,
	copyFileToMp4,
	generatePreviewGif,
	generateThumbnail,
	materializeHlsPlaylist,
	materializeMpdAsHlsPlaylist,
	materializeMpdManifest,
	materializeStreamingInput,
	muxMediaTracksToMp4,
	normalizeVideoInputExtension,
	pickMobileSafeH264Level,
	processVideo,
	repairContainer,
	uploadToS3,
} from "../../lib/media-video";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = join(FIXTURES_DIR, "test-with-audio.mp4");

const tempFiles: string[] = [];

async function expectRejected(promise: Promise<unknown>): Promise<void> {
	let rejected = false;
	try {
		await promise;
	} catch {
		rejected = true;
	}
	expect(rejected).toBe(true);
}

function readH264Level(filePath: string): number {
	const output = execFileSync("ffprobe", [
		"-hide_banner",
		"-v",
		"error",
		"-select_streams",
		"v:0",
		"-show_entries",
		"stream=level",
		"-of",
		"default=noprint_wrappers=1:nokey=1",
		filePath,
	])
		.toString()
		.trim();

	return Number.parseInt(output, 10);
}

afterAll(() => {
	for (const file of tempFiles) {
		if (existsSync(file)) {
			rmSync(file);
		}
	}
});

describe("generateThumbnail integration tests", () => {
	test("generates JPEG thumbnail from video", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);

		expect(thumbnailData[0]).toBe(0xff);
		expect(thumbnailData[1]).toBe(0xd8);
	});

	test("generates thumbnail at specific timestamp", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ timestamp: 0.1 },
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);
	});

	test("generates thumbnail with custom dimensions", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const thumbnailData = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ width: 320, height: 180 },
		);

		expect(thumbnailData).toBeInstanceOf(Uint8Array);
		expect(thumbnailData.length).toBeGreaterThan(0);
	});

	test("generates thumbnail with custom quality", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const highQuality = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ quality: 95 },
		);

		const lowQuality = await generateThumbnail(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ quality: 10 },
		);

		expect(highQuality.length).toBeGreaterThanOrEqual(lowQuality.length);
	});

	test("throws error for non-existent video", async () => {
		await expectRejected(
			generateThumbnail("/nonexistent/path/to/video.mp4", 10),
		);
	});
});

describe("generatePreviewGif integration tests", () => {
	test("generates small GIF preview from video", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const preview = await generatePreviewGif(
			TEST_VIDEO_WITH_AUDIO,
			metadata.duration,
			{ maxBytes: 100_000 },
		);

		try {
			const previewData = readFileSync(preview.path);

			expect(previewData.length).toBeGreaterThan(0);
			expect(previewData.length).toBeLessThanOrEqual(100_000);
			expect(previewData.subarray(0, 3).toString()).toBe("GIF");
		} finally {
			await preview.cleanup();
		}
	});

	test("rejects GIF previews over the size budget", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		await expect(
			generatePreviewGif(TEST_VIDEO_WITH_AUDIO, metadata.duration, {
				maxBytes: 1,
			}),
		).rejects.toThrow("Preview GIF exceeds size budget");
	});

	test("rejects before spawning when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			generatePreviewGif(TEST_VIDEO_WITH_AUDIO, 10, {}, controller.signal),
		).rejects.toThrow("Preview GIF generation aborted");
	});
});

describe("processVideo integration tests", () => {
	test("retries transient S3 upload failures", async () => {
		const originalFetch = globalThis.fetch;
		let attempts = 0;

		globalThis.fetch = (async () => {
			attempts++;
			if (attempts === 1) {
				const error = new Error(
					"The socket connection was closed unexpectedly.",
				);
				Object.assign(error, { code: "ECONNRESET" });
				throw error;
			}

			return new Response(null, {
				status: 200,
				statusText: "OK",
			});
		}) as unknown as typeof fetch;

		try {
			await uploadToS3(
				new Uint8Array([1, 2, 3, 4]),
				"https://uploads.example/result.mp4",
				"video/mp4",
			);
			expect(attempts).toBe(2);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("does not retry non-retryable S3 upload failures", async () => {
		const originalFetch = globalThis.fetch;
		let attempts = 0;

		globalThis.fetch = (async () => {
			attempts++;
			return new Response(null, {
				status: 403,
				statusText: "Forbidden",
			});
		}) as unknown as typeof fetch;

		try {
			await expect(
				uploadToS3(
					new Uint8Array([1, 2, 3, 4]),
					"https://uploads.example/result.mp4",
					"video/mp4",
				),
			).rejects.toThrow("Storage upload failed: 403 Forbidden");
			expect(attempts).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("escapes signed DASH manifest URLs in XML attributes", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-mpd-"));

		globalThis.fetch = (async () =>
			new Response(
				'<MPD><Period><AdaptationSet><Representation><SegmentTemplate initialization="init.mp4" media="chunk-$Number$.m4s"/><Initialization sourceURL="escaped.mp4?part=1&amp;token=x"/></Representation></AdaptationSet></Period></MPD>',
				{ status: 200, statusText: "OK" },
			)) as unknown as typeof fetch;

		try {
			const path = await materializeMpdManifest(
				"https://cdn.example/video/manifest.mpd?Policy=a&Signature=b&Key-Pair-Id=c",
				manifestDir,
			);
			const content = readFileSync(path, "utf8");

			expect(content).toContain(
				"init.mp4?Policy=a&amp;Signature=b&amp;Key-Pair-Id=c",
			);
			expect(content).toContain(
				"chunk-$Number$.m4s?Policy=a&amp;Signature=b&amp;Key-Pair-Id=c",
			);
			expect(content).toContain("escaped.mp4?part=1&amp;token=x");
			expect(content).not.toContain("&amp;amp;");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("materializes signed DASH SegmentTemplate manifests as HLS", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-mpd-hls-"));

		globalThis.fetch = (async () =>
			new Response(
				`<MPD mediaPresentationDuration="PT2S">
					<Period>
						<AdaptationSet contentType="video" mimeType="video/mp4" codecs="avc1.4d401f" width="640" height="360">
							<Representation id="v1" bandwidth="800000">
								<SegmentTemplate timescale="1000" duration="1000" initialization="video/init-$RepresentationID$.mp4" media="video/chunk-$Number%05d$.m4s" startNumber="3"/>
							</Representation>
						</AdaptationSet>
						<AdaptationSet contentType="audio" mimeType="audio/mp4" codecs="mp4a.40.2">
							<Representation id="a1" bandwidth="96000">
								<SegmentTemplate timescale="48000" initialization="audio/init.mp4" media="audio/chunk-$Time$.m4s">
									<SegmentTimeline><S t="0" d="48000" r="1"/></SegmentTimeline>
								</SegmentTemplate>
							</Representation>
						</AdaptationSet>
					</Period>
				</MPD>`,
				{ status: 200, statusText: "OK" },
			)) as unknown as typeof fetch;

		try {
			const masterPath = await materializeMpdAsHlsPlaylist(
				"https://cdn.example/video/manifest.mpd?Policy=a&Signature=b",
				manifestDir,
			);
			const master = readFileSync(masterPath, "utf8");
			const mediaMatch = master.match(/#EXT-X-MEDIA:[^\n]+URI="([^"]+)"/);
			const masterLines = master.split("\n");
			const streamIndex = masterLines.findIndex((line) =>
				line.startsWith("#EXT-X-STREAM-INF:"),
			);
			const videoPlaylistPath = masterLines[streamIndex + 1];

			expect(mediaMatch?.[1]).toBeTruthy();
			expect(videoPlaylistPath).toBeTruthy();
			expect(master).toContain('CODECS="avc1.4d401f,mp4a.40.2"');

			const videoPlaylist = readFileSync(videoPlaylistPath ?? "", "utf8");
			const audioPlaylist = readFileSync(mediaMatch?.[1] ?? "", "utf8");

			expect(videoPlaylist).toContain(
				"https://cdn.example/video/video/init-v1.mp4?Policy=a&Signature=b",
			);
			expect(videoPlaylist).toContain(
				"https://cdn.example/video/video/chunk-00003.m4s?Policy=a&Signature=b",
			);
			expect(videoPlaylist).toContain(
				"https://cdn.example/video/video/chunk-00004.m4s?Policy=a&Signature=b",
			);
			expect(audioPlaylist).toContain(
				"https://cdn.example/video/audio/chunk-0.m4s?Policy=a&Signature=b",
			);
			expect(audioPlaylist).toContain(
				"https://cdn.example/video/audio/chunk-48000.m4s?Policy=a&Signature=b",
			);
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("falls back to generic DASH manifest materialization for unsupported MPD shapes", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-mpd-fallback-"));
		let requests = 0;

		globalThis.fetch = (async () => {
			requests++;
			return new Response(
				`<MPD>
						<Period>
							<AdaptationSet mimeType="video/mp4">
								<Representation id="v1" bandwidth="800000">
									<BaseURL>media/</BaseURL>
									<SegmentList>
										<Initialization sourceURL="init.mp4"/>
										<SegmentURL media="seg-1.m4s"/>
									</SegmentList>
								</Representation>
							</AdaptationSet>
						</Period>
					</MPD>`,
				{ status: 200, statusText: "OK" },
			);
		}) as unknown as typeof fetch;

		try {
			const path = await materializeStreamingInput(
				"https://cdn.example/video/manifest.mpd?Policy=a&Signature=b",
				manifestDir,
			);
			const content = readFileSync(path, "utf8");

			expect(path.endsWith(".mpd")).toBe(true);
			expect(requests).toBe(2);
			expect(content).toContain(
				"https://cdn.example/video/media/?Policy=a&amp;Signature=b",
			);
			expect(content).toContain("seg-1.m4s?Policy=a&amp;Signature=b");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("does not retry DASH materialization when the manifest fetch fails", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-mpd-fetch-fail-"));
		let requests = 0;

		globalThis.fetch = (async () => {
			requests++;
			return new Response("", { status: 403, statusText: "Forbidden" });
		}) as unknown as typeof fetch;

		try {
			await expect(
				materializeStreamingInput(
					"https://cdn.example/video/manifest.mpd?Policy=a&Signature=b",
					manifestDir,
				),
			).rejects.toThrow("Failed to fetch DASH manifest: 403 Forbidden");
			expect(requests).toBe(1);
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("rejects local file references in remote DASH manifests", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-mpd-local-file-"));

		globalThis.fetch = (async () =>
			new Response(
				`<MPD>
					<Period>
						<AdaptationSet mimeType="video/mp4">
							<Representation id="v1" bandwidth="800000">
								<BaseURL>file:///etc/</BaseURL>
								<SegmentList>
									<Initialization sourceURL="passwd"/>
								</SegmentList>
							</Representation>
						</AdaptationSet>
					</Period>
				</MPD>`,
				{ status: 200, statusText: "OK" },
			)) as unknown as typeof fetch;

		try {
			await expect(
				materializeStreamingInput(
					"https://cdn.example/video/manifest.mpd",
					manifestDir,
				),
			).rejects.toThrow("Unsupported media resource protocol: file:");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("materializes signed HLS playlists with inherited query strings", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-hls-"));
		const requestedUrls: string[] = [];

		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = input instanceof Request ? input.url : input.toString();
			requestedUrls.push(url);

			if (url.includes("/master.m3u8")) {
				return new Response(
					[
						"#EXTM3U",
						"#EXT-X-STREAM-INF:BANDWIDTH=1000000",
						"variant.m3u8",
					].join("\n"),
					{ status: 200, statusText: "OK" },
				);
			}

			if (url.includes("/variant.m3u8")) {
				return new Response(
					[
						"#EXTM3U",
						"#EXT-X-TARGETDURATION:2",
						'#EXT-X-MAP:URI="init.mp4"',
						'#EXT-X-KEY:METHOD=AES-128,URI="key.bin"',
						"#EXTINF:1,",
						"segment-1.ts",
						"#EXTINF:1,",
						"segment-2.ts",
						"#EXT-X-ENDLIST",
					].join("\n"),
					{ status: 200, statusText: "OK" },
				);
			}

			return new Response("not found", {
				status: 404,
				statusText: "Not Found",
			});
		}) as unknown as typeof fetch;

		try {
			const masterPath = await materializeHlsPlaylist(
				"https://cdn.example/video/master.m3u8?Policy=a&Signature=b",
				manifestDir,
			);
			const master = readFileSync(masterPath, "utf8");
			const variantPath = master
				.split("\n")
				.find((line) => line.startsWith(manifestDir));

			expect(requestedUrls).toContain(
				"https://cdn.example/video/variant.m3u8?Policy=a&Signature=b",
			);
			expect(variantPath).toBeTruthy();

			const variant = readFileSync(variantPath ?? "", "utf8");
			expect(variant).toContain(
				'URI="https://cdn.example/video/init.mp4?Policy=a&Signature=b"',
			);
			expect(variant).toContain(
				'URI="https://cdn.example/video/key.bin?Policy=a&Signature=b"',
			);
			expect(variant).toContain(
				"https://cdn.example/video/segment-1.ts?Policy=a&Signature=b",
			);
			expect(variant).toContain(
				"https://cdn.example/video/segment-2.ts?Policy=a&Signature=b",
			);
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("rejects local file references in remote HLS playlists", async () => {
		const originalFetch = globalThis.fetch;
		const manifestDir = mkdtempSync(join(tmpdir(), "cap-hls-local-file-"));

		globalThis.fetch = (async () =>
			new Response(
				["#EXTM3U", "#EXTINF:1.0,", "file:///etc/passwd"].join("\n"),
			)) as unknown as typeof fetch;

		try {
			await expect(
				materializeStreamingInput(
					"https://cdn.example/video/manifest.m3u8",
					manifestDir,
				),
			).rejects.toThrow("Unsupported media resource protocol: file:");
		} finally {
			globalThis.fetch = originalFetch;
			rmSync(manifestDir, { recursive: true, force: true });
		}
	});

	test("waits for async cleanup before rejecting timed out work", async () => {
		let resolveCleanup: (() => void) | undefined;
		let settled = false;
		const cleanupFinished = new Promise<void>((resolve) => {
			resolveCleanup = resolve;
		});

		const timedOutWork = withTimeout(
			new Promise<never>(() => {}),
			1,
			async () => {
				await cleanupFinished;
			},
		);

		void timedOutWork.catch(() => {
			settled = true;
		});

		await Bun.sleep(25);
		expect(settled).toBe(false);

		resolveCleanup?.();

		await expect(timedOutWork).rejects.toThrow("Operation timed out after 1ms");
		expect(settled).toBe(true);
	});

	test("normalizes input extensions", () => {
		expect(normalizeVideoInputExtension(undefined)).toBe(".mp4");
		expect(normalizeVideoInputExtension("webm")).toBe(".webm");
		expect(normalizeVideoInputExtension(".MOV")).toBe(".mov");
	});

	test("processes video and produces valid output", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		let lastProgress = 0;
		const progressUpdates: number[] = [];

		const tempFile = await processVideo(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			{ maxWidth: 640, maxHeight: 360 },
			(progress, _message) => {
				expect(progress).toBeGreaterThanOrEqual(lastProgress);
				progressUpdates.push(progress);
				lastProgress = progress;
			},
		);

		tempFiles.push(tempFile.path);

		expect(existsSync(tempFile.path)).toBe(true);

		const outputMetadata = await probeVideo(`file://${tempFile.path}`);
		expect(outputMetadata.width).toBeLessThanOrEqual(640);
		expect(outputMetadata.height).toBeLessThanOrEqual(360);
		expect(outputMetadata.videoCodec).toBe("h264");

		expect(progressUpdates.length).toBeGreaterThan(0);
		expect(progressUpdates[progressUpdates.length - 1]).toBeGreaterThanOrEqual(
			50,
		);

		await tempFile.cleanup();
		expect(existsSync(tempFile.path)).toBe(false);
	}, 60000);

	test("respects CRF setting", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);

		const highQualityFile = await processVideo(
			TEST_VIDEO_WITH_AUDIO,
			metadata,
			{ crf: 18, maxWidth: 160, maxHeight: 120 },
		);
		tempFiles.push(highQualityFile.path);

		const lowQualityFile = await processVideo(TEST_VIDEO_WITH_AUDIO, metadata, {
			crf: 35,
			maxWidth: 160,
			maxHeight: 120,
		});
		tempFiles.push(lowQualityFile.path);

		const highQualityMetadata = await probeVideo(
			`file://${highQualityFile.path}`,
		);
		const lowQualityMetadata = await probeVideo(
			`file://${lowQualityFile.path}`,
		);

		expect(highQualityMetadata.bitrate).toBeGreaterThanOrEqual(
			lowQualityMetadata.bitrate,
		);

		await highQualityFile.cleanup();
		await lowQualityFile.cleanup();
	}, 120000);

	test("throws error for non-existent video", async () => {
		const fakeMetadata = {
			duration: 10,
			width: 1920,
			height: 1080,
			fps: 30,
			videoCodec: "h264",
			audioCodec: null,
			audioChannels: null,
			sampleRate: null,
			bitrate: 5000000,
			fileSize: 0,
		};

		await expectRejected(
			processVideo("/nonexistent/path/to/video.mp4", fakeMetadata, {}),
		);
	});

	test("remuxes compatible mp4 input into a valid mp4 output", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const tempFile = await processVideo(TEST_VIDEO_WITH_AUDIO, metadata, {
			remuxOnly: true,
		});
		tempFiles.push(tempFile.path);

		const outputMetadata = await probeVideo(`file://${tempFile.path}`);
		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBe("aac");

		await tempFile.cleanup();
	}, 120000);

	test("does not recompress compatible mp4 input when no transcode is needed", async () => {
		const metadata = await probeVideo(`file://${TEST_VIDEO_WITH_AUDIO}`);
		const sourceSize = statSync(TEST_VIDEO_WITH_AUDIO).size;
		const tempFile = await processVideo(TEST_VIDEO_WITH_AUDIO, metadata, {
			maxWidth: metadata.width,
			maxHeight: metadata.height,
		});
		tempFiles.push(tempFile.path);

		const outputSize = statSync(tempFile.path).size;
		const outputMetadata = await probeVideo(`file://${tempFile.path}`);

		expect(outputMetadata.videoCodec).toBe("h264");
		expect(outputMetadata.audioCodec).toBe("aac");
		expect(outputSize).toBeGreaterThan(Math.round(sourceSize * 0.75));

		await tempFile.cleanup();
	}, 120000);

	test("re-encodes compatible h264 input when the level is unsafe for mobile", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "cap-high-level-h264-"));
		try {
			const highLevelPath = join(workDir, "high-level.mp4");
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				TEST_VIDEO_WITH_AUDIO,
				"-c:v",
				"libx264",
				"-level:v",
				"6.1",
				"-c:a",
				"copy",
				highLevelPath,
			]);

			const metadata = await probeVideo(`file://${highLevelPath}`);
			const expectedLevel = pickMobileSafeH264Level(metadata, {
				maxWidth: metadata.width,
				maxHeight: metadata.height,
			});

			expect(readH264Level(highLevelPath)).toBeGreaterThan(expectedLevel.value);

			const tempFile = await processVideo(highLevelPath, metadata, {
				maxWidth: metadata.width,
				maxHeight: metadata.height,
			});
			tempFiles.push(tempFile.path);

			expect(readH264Level(tempFile.path)).toBeLessThanOrEqual(
				expectedLevel.value,
			);

			await tempFile.cleanup();
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	}, 120000);

	test("transcodes raw webm input into a valid mp4 output", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "cap-webm-transcode-"));
		try {
			const rawWebmPath = join(workDir, "input.webm");

			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				TEST_VIDEO_WITH_AUDIO,
				"-c:v",
				"libvpx-vp9",
				"-c:a",
				"libopus",
				rawWebmPath,
			]);

			const metadata = await probeVideo(`file://${rawWebmPath}`);
			const tempFile = await processVideo(rawWebmPath, metadata, {});
			tempFiles.push(tempFile.path);

			const outputMetadata = await probeVideo(`file://${tempFile.path}`);
			expect(outputMetadata.videoCodec).toBe("h264");
			expect(outputMetadata.audioCodec).toBe("aac");

			await tempFile.cleanup();
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	}, 120000);
});

describe("ffmpeg-backed media utilities integration tests", () => {
	test("allows Loom DASH webm segments in generated HLS downloads", () => {
		const args = buildStreamingDownloadFfmpegArgs(
			"/tmp/input.m3u8",
			"/tmp/output.mkv",
		);

		expect(args).toContain("-allowed_segment_extensions");
		expect(args).toContain("-extension_picky");
		expect(args[args.indexOf("-allowed_segment_extensions") + 1]).toBe("ALL");
		expect(args[args.indexOf("-extension_picky") + 1]).toBe("0");
	});

	test("repairs a real mp4 container into a probeable file", async () => {
		const repairedFile = await repairContainer(TEST_VIDEO_WITH_AUDIO);
		tempFiles.push(repairedFile.path);

		const metadata = await probeVideo(`file://${repairedFile.path}`);
		expect(metadata.videoCodec).toBe("h264");
		expect(metadata.audioCodec).toBe("aac");
		expect(metadata.duration).toBeGreaterThan(0);

		await repairedFile.cleanup();
	}, 60000);

	test("copies a real media file to mp4 through the production remux path", async () => {
		const copiedFile = await copyFileToMp4(TEST_VIDEO_WITH_AUDIO);
		tempFiles.push(copiedFile.path);

		const metadata = await probeVideo(`file://${copiedFile.path}`);
		expect(metadata.videoCodec).toBe("h264");
		expect(metadata.audioCodec).toBe("aac");
		expect(metadata.duration).toBeGreaterThan(0);

		await copiedFile.cleanup();
	}, 60000);

	test("muxes real video and audio tracks into a valid mp4", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "cap-mux-"));
		try {
			const videoOnlyPath = join(workDir, "video-only.mp4");
			const audioOnlyPath = join(workDir, "audio-only.m4a");
			const outputPath = join(workDir, "muxed.mp4");

			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				TEST_VIDEO_WITH_AUDIO,
				"-map",
				"0:v:0",
				"-c",
				"copy",
				"-an",
				videoOnlyPath,
			]);
			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				TEST_VIDEO_WITH_AUDIO,
				"-map",
				"0:a:0",
				"-c",
				"copy",
				audioOnlyPath,
			]);

			await muxMediaTracksToMp4(videoOnlyPath, audioOnlyPath, outputPath);

			const metadata = await probeVideo(`file://${outputPath}`);
			expect(metadata.videoCodec).toBe("h264");
			expect(metadata.audioCodec).toBe("aac");
			expect(metadata.duration).toBeGreaterThan(0);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	}, 60000);

	test("muxes a real video-only track without creating an audio stream", async () => {
		const workDir = mkdtempSync(join(tmpdir(), "cap-mux-video-only-"));
		try {
			const videoOnlyPath = join(workDir, "video-only.mp4");
			const outputPath = join(workDir, "muxed-video-only.mp4");

			execFileSync("ffmpeg", [
				"-hide_banner",
				"-loglevel",
				"error",
				"-y",
				"-i",
				TEST_VIDEO_WITH_AUDIO,
				"-map",
				"0:v:0",
				"-c",
				"copy",
				"-an",
				videoOnlyPath,
			]);

			await muxMediaTracksToMp4(videoOnlyPath, null, outputPath);

			const metadata = await probeVideo(`file://${outputPath}`);
			expect(metadata.videoCodec).toBe("h264");
			expect(metadata.audioCodec).toBeNull();
			expect(metadata.duration).toBeGreaterThan(0);
		} finally {
			rmSync(workDir, { recursive: true, force: true });
		}
	}, 60000);
});
