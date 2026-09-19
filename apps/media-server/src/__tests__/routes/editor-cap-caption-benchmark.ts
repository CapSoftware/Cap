import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	CAP_BUNDLE_HEADER_BYTES,
	CAP_BUNDLE_MAGIC,
	parseCapBundleManifest,
	readCapBundleManifestLength,
	validCapBundlePath,
} from "@cap/editor-cap-bundle";
import { prepareEditorCapCaptionAudio } from "../../lib/editor-cap-captions";

const runFile = promisify(execFile);
const binary = process.env.CAP_WEB_EDITOR_PREPARE_BIN;
assert.ok(binary);
const recordingSeconds = 900;
const root = await mkdtemp(join(tmpdir(), "cap-editor-caption-benchmark-"));

async function durationMs(path: string) {
	const { stdout } = await runFile("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=nw=1:nk=1",
		path,
	]);
	const seconds = Number(stdout.trim());
	assert.ok(Number.isFinite(seconds) && seconds > 0);
	return Math.round(seconds * 1000);
}

async function bundleProject(sourceProject: string) {
	const sources: Array<{ path: string; absolutePath: string; size: number }> =
		[];
	const directories = [sourceProject];
	while (directories.length > 0) {
		const directory = directories.pop();
		assert.ok(directory);
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const absolutePath = join(directory, entry.name);
			if (entry.isDirectory()) {
				directories.push(absolutePath);
			} else if (entry.isFile()) {
				const path = relative(sourceProject, absolutePath).replaceAll(
					"\\",
					"/",
				);
				if (validCapBundlePath(path)) {
					sources.push({
						path,
						absolutePath,
						size: (await lstat(absolutePath)).size,
					});
				}
			}
		}
	}
	sources.sort((a, b) => a.path.localeCompare(b.path));
	let offset = 0;
	const files = sources.map((source) => {
		const entry = { path: source.path, size: source.size, offset };
		offset += source.size;
		return entry;
	});
	const manifestBytes = new TextEncoder().encode(
		JSON.stringify({ version: 1, files }),
	);
	const header = new Uint8Array(CAP_BUNDLE_HEADER_BYTES);
	header.set(new TextEncoder().encode(CAP_BUNDLE_MAGIC));
	new DataView(header.buffer).setUint32(8, manifestBytes.length, true);
	const bundlePath = join(root, "source.capbundle");
	const destination = await open(bundlePath, "wx", 0o600);
	try {
		await destination.writeFile(header);
		await destination.writeFile(manifestBytes);
		for (const source of sources) {
			for await (const chunk of createReadStream(source.absolutePath, {
				highWaterMark: 1024 * 1024,
			})) {
				await destination.writeFile(chunk);
			}
		}
	} finally {
		await destination.close();
	}
	const size = (await lstat(bundlePath)).size;
	assert.equal(size, CAP_BUNDLE_HEADER_BYTES + manifestBytes.length + offset);
	assert.equal(readCapBundleManifestLength(header), manifestBytes.length);
	assert.ok(parseCapBundleManifest(manifestBytes, size));
	return bundlePath;
}

try {
	const display = join(root, "display.mp4");
	const camera = join(root, "camera.mp4");
	const mic = join(root, "mic.wav");
	const systemAudio = join(root, "system.wav");
	const generatedStart = performance.now();
	await Promise.all([
		runFile(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"testsrc2=size=1920x1080:rate=1",
				"-t",
				String(recordingSeconds),
				"-threads",
				"4",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-crf",
				"38",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				display,
			],
			{ timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 },
		),
		runFile(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=640x360:r=1",
				"-t",
				String(recordingSeconds),
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-pix_fmt",
				"yuv420p",
				camera,
			],
			{ timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 },
		),
		...[
			{ frequency: 440, path: mic },
			{ frequency: 660, path: systemAudio },
		].map(({ frequency, path }) =>
			runFile(
				"ffmpeg",
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					`sine=frequency=${frequency}:sample_rate=48000`,
					"-t",
					String(recordingSeconds),
					"-ac",
					"1",
					"-c:a",
					"pcm_s16le",
					path,
				],
				{ timeout: 5 * 60 * 1000, maxBuffer: 64 * 1024 },
			),
		),
	]);
	const generatedMs = Math.round(performance.now() - generatedStart);
	const sourceProject = join(root, `${randomUUID()}.cap`);
	const manifestPath = join(root, "manifest.json");
	await writeFile(
		manifestPath,
		JSON.stringify({
			version: 1,
			title:
				"Fifteen-minute separate screen, webcam, microphone, and system audio",
			displayPath: display,
			displayFps: 30,
			cameraPath: camera,
			cameraFps: 25,
			cameraOffsetMs: 0,
			micPath: mic,
			systemAudioPath: systemAudio,
			mixedAudioInDisplay: false,
		}),
	);
	await runFile(binary, ["prepare", sourceProject, manifestPath], {
		timeout: 5 * 60 * 1000,
		maxBuffer: 64 * 1024,
	});
	const bundlePath = await bundleProject(sourceProject);
	const bundle = Bun.file(bundlePath);
	const etag = '"cap-caption-900s"';
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.headers.get("if-match") !== etag) {
				return new Response(null, { status: 412 });
			}
			return new Response(bundle, {
				headers: {
					ETag: etag,
					"Content-Length": String(bundle.size),
				},
			});
		},
	});
	const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	try {
		const displayDurationMs = await durationMs(display);
		const segmentDurationMs = Math.max(
			displayDurationMs,
			await durationMs(camera),
			await durationMs(mic),
			await durationMs(systemAudio),
		);
		const expectedSegments = [
			{
				mediaDurationMs: displayDurationMs,
				segmentDurationMs,
				hasAudio: true,
			},
		];
		let peakRss = process.memoryUsage().rss;
		const sampler = setInterval(() => {
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
		}, 100);
		const started = performance.now();
		let prepared: Awaited<ReturnType<typeof prepareEditorCapCaptionAudio>>;
		try {
			prepared = await prepareEditorCapCaptionAudio(
				{
					path: `content/imports/${randomUUID()}.capbundle`,
					name: "Fifteen-minute Studio source",
					url: `http://127.0.0.1:${server.port}/source.capbundle`,
					size: bundle.size,
					contentType: CAP_BUNDLE_CONTENT_TYPE,
					objectIdentity: etag,
				},
				expectedSegments,
			);
		} finally {
			clearInterval(sampler);
		}
		const captionPrepareMs = Math.round(performance.now() - started);
		try {
			const actualDurationMs = await durationMs(prepared.path);
			assert.ok(Math.abs(actualDurationMs - segmentDurationMs) <= 250);
			const output = await lstat(prepared.path);
			assert.equal(output.size, prepared.size);
			process.stdout.write(
				`${JSON.stringify({
					recordingSeconds,
					generatedMs,
					bundleMiB: Math.round(bundle.size / 1024 / 1024),
					captionPrepareMs,
					captionAudioMiB: Math.round(prepared.size / 1024 / 1024),
					peakBunRssMiB: Math.round(peakRss / 1024 / 1024),
					actualDurationMs,
				})}\n`,
			);
		} finally {
			await prepared.cleanup();
		}
	} finally {
		server.stop(true);
		if (previousAllowHttp === undefined) {
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		} else {
			process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
		}
	}
} finally {
	await rm(root, { recursive: true, force: true });
}
