import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { VideoMetadata } from "@cap/database/types";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	createCapBundle,
	validCapBundlePath,
} from "@cap/editor-cap-bundle";
import editorWorkerApp from "../../editor-worker-app";
import { extractEditorCapBundle } from "../../lib/editor-cap-bundle";
import { prepareEditorCapCaptionAudio } from "../../lib/editor-cap-captions";
import {
	prepareNativeEditorProject,
	startNativeEditorSession,
} from "../../lib/editor-native";

const runFile = promisify(execFile);
const binary = process.env.CAP_WEB_EDITOR_PREPARE_BIN;
assert.ok(binary);
const fixtures = join(import.meta.dir, "../fixtures/editor-clips");
const screen = join(fixtures, "display-red.webm");
const camera = join(fixtures, "camera-green.webm");
const imported = join(fixtures, "clip-blue-audio.mp4");
const cursorImage = join(import.meta.dir, "../fixtures/exif-orientation-6.jpg");

type VideoPath = { path: string };
type Segment = {
	display: VideoPath;
	camera?: VideoPath;
	mic?: VideoPath;
	system_audio?: VideoPath;
	cursor?: string;
	keyboard?: string;
};
type Cursor = { imagePath: string; hotspot: { x: number; y: number } };
type RecordingMeta = {
	segments: Segment[];
	cursors: Record<string, Cursor>;
};
type TimelineSegment = {
	recordingSegment: number;
	timescale: number;
	start: number;
	end: number;
	speedAudioMode?: string;
	hideCursor?: boolean;
	volume?: number;
	name?: string | null;
};
type ProjectConfig = {
	timeline?: { segments: TimelineSegment[]; zoomSegments: unknown[] };
};

async function jsonFile<T>(path: string): Promise<T> {
	return JSON.parse(await Bun.file(path).text()) as T;
}

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

async function bundleProject(sourceProject: string, bundlePath: string) {
	const sources: Array<{ path: string; file: Blob }> = [];
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
						file: new Blob([await readFile(absolutePath)]),
					});
				}
			}
		}
	}
	const bundle = createCapBundle(sources);
	await writeFile(bundlePath, new Uint8Array(await bundle.arrayBuffer()));
}

const temporary = await mkdtemp(join(tmpdir(), "cap-editor-cap-import-"));
try {
	const sourceProject = join(temporary, `${randomUUID()}.cap`);
	const instantProject = join(temporary, `${randomUUID()}.cap`);
	const targetProject = join(temporary, `${randomUUID()}.cap`);
	const sourceManifest = join(temporary, "source-manifest.json");
	const targetManifest = join(temporary, "target-manifest.json");
	const mic = join(temporary, "mic.wav");
	const systemAudio = join(temporary, "system.wav");
	await runFile("ffmpeg", [
		"-hide_banner",
		"-loglevel",
		"error",
		"-f",
		"lavfi",
		"-i",
		"sine=frequency=880:sample_rate=48000",
		"-t",
		"3",
		"-ac",
		"2",
		mic,
	]);
	await copyFile(mic, systemAudio);
	await writeFile(
		sourceManifest,
		JSON.stringify({
			version: 1,
			title: "Two source clips with separate camera and audio tracks",
			displayPath: screen,
			displayFps: 30,
			cameraPath: camera,
			cameraFps: 25,
			cameraOffsetMs: 125,
			micPath: mic,
			systemAudioPath: systemAudio,
			mixedAudioInDisplay: false,
		}),
	);
	await writeFile(
		targetManifest,
		JSON.stringify({
			version: 1,
			title: "Target editor project",
			displayPath: imported,
			displayFps: 30,
			mixedAudioInDisplay: true,
		}),
	);
	await Promise.all([
		runFile(binary, ["prepare", sourceProject, sourceManifest]),
		runFile(binary, ["prepare", targetProject, targetManifest]),
	]);
	const sourceVideos = join(sourceProject, "content/videos");
	await mkdir(sourceVideos, { recursive: true });
	const extraDisplay = join(sourceVideos, "extra-display.mp4");
	const extraCamera = join(sourceVideos, "extra-camera.webm");
	await Promise.all([
		copyFile(imported, extraDisplay),
		copyFile(camera, extraCamera),
	]);
	const clipManifest = join(temporary, "clip-manifest.json");
	await writeFile(
		clipManifest,
		JSON.stringify({
			version: 1,
			clips: [
				{
					displayPath: extraDisplay,
					cameraPath: extraCamera,
					duration: 2,
					fps: 30,
					hasAudio: true,
					cameraFps: 25,
					cameraOffsetMs: 125,
				},
			],
		}),
	);
	await runFile(binary, ["append-clips", sourceProject, clipManifest]);
	const sourceMetaPath = join(sourceProject, "recording-meta.json");
	const sourceMeta = await jsonFile<RecordingMeta>(sourceMetaPath);
	assert.equal(sourceMeta.segments.length, 2);
	const cursorRelative = "content/segments/segment-0/cursor.json";
	const keyboardRelative = "content/segments/segment-0/keyboard.json";
	const cursorImageRelative = "content/cursors/source-cursor.jpg";
	const cursorDirectory = join(sourceProject, "content/cursors");
	await mkdir(cursorDirectory, { recursive: true });
	await copyFile(cursorImage, join(sourceProject, cursorImageRelative));
	await writeFile(
		join(sourceProject, cursorRelative),
		JSON.stringify({
			clicks: [
				{
					active_modifiers: [],
					cursor_num: 0,
					cursor_id: "source-cursor",
					time_ms: 500,
					down: true,
				},
			],
			moves: [
				{
					active_modifiers: [],
					cursor_id: "source-cursor",
					time_ms: 400,
					x: 0.3,
					y: 0.4,
				},
			],
		}),
	);
	await writeFile(
		join(sourceProject, keyboardRelative),
		JSON.stringify({
			presses: [
				{
					key: "A",
					keyCode: "KeyA",
					timeMs: 650,
					down: true,
				},
			],
		}),
	);
	const sourceFirstSegment = sourceMeta.segments[0];
	assert.ok(sourceFirstSegment);
	sourceFirstSegment.cursor = cursorRelative;
	sourceFirstSegment.keyboard = keyboardRelative;
	sourceMeta.cursors = {
		"source-cursor": {
			imagePath: cursorImageRelative,
			hotspot: { x: 4, y: 5 },
		},
	};
	await writeFile(sourceMetaPath, JSON.stringify(sourceMeta));
	const sourceConfigPath = join(sourceProject, "project-config.json");
	const sourceConfig = await jsonFile<ProjectConfig>(sourceConfigPath);
	sourceConfig.timeline = {
		segments: [
			{
				recordingSegment: 0,
				timescale: 1.5,
				start: 0.2,
				end: 1.6,
				speedAudioMode: "maintainPitch",
				hideCursor: false,
				volume: 0.75,
			},
			{
				recordingSegment: 1,
				timescale: 1,
				start: 0,
				end: 1.2,
				hideCursor: true,
			},
		],
		zoomSegments: [],
	};
	await writeFile(sourceConfigPath, JSON.stringify(sourceConfig));
	const sourcePreviewSettingsPath = join(
		temporary,
		"source-preview-settings.json",
	);
	await writeFile(
		sourcePreviewSettingsPath,
		JSON.stringify({
			fps: 30,
			resolution_base: { x: 640, y: 360 },
			compression_bpp: 0.7,
		}),
	);
	await runFile(binary, [
		"preview",
		sourceProject,
		sourceConfigPath,
		"0.25",
		sourcePreviewSettingsPath,
		join(temporary, "source-preview.jpg"),
	]);
	const bundlePath = join(temporary, "source.capbundle");
	await bundleProject(sourceProject, bundlePath);
	const extracted = await extractEditorCapBundle(bundlePath);
	let appendedStdout = "";
	try {
		const appended = await runFile(binary, [
			"append-cap",
			targetProject,
			extracted.path,
		]);
		appendedStdout = appended.stdout.toString();
	} finally {
		await extracted.cleanup();
	}
	assert.equal(
		(JSON.parse(appendedStdout) as { clipCount: number }).clipCount,
		2,
	);
	const targetMeta = await jsonFile<RecordingMeta>(
		join(targetProject, "recording-meta.json"),
	);
	assert.equal(targetMeta.segments.length, 3);
	const firstImported = targetMeta.segments[1];
	const secondImported = targetMeta.segments[2];
	assert.ok(firstImported?.camera?.path);
	assert.ok(firstImported?.mic?.path);
	assert.ok(firstImported?.system_audio?.path);
	assert.ok(firstImported?.cursor);
	assert.ok(firstImported?.keyboard);
	assert.ok(secondImported?.camera?.path);
	assert.equal(
		secondImported?.system_audio?.path,
		secondImported?.display.path,
	);
	const sourceAudioSegments = await Promise.all(
		sourceMeta.segments.map(async (segment) => {
			const mediaDurationMs = await durationMs(
				join(sourceProject, segment.display.path),
			);
			const trackPaths = [
				segment.camera?.path,
				segment.mic?.path,
				segment.system_audio?.path,
			].filter((path): path is string => typeof path === "string");
			const trackDurations = await Promise.all(
				trackPaths.map((path) => durationMs(join(sourceProject, path))),
			);
			return {
				mediaDurationMs,
				segmentDurationMs: Math.max(mediaDurationMs, ...trackDurations),
				hasAudio: Boolean(segment.mic || segment.system_audio),
			};
		}),
	);
	const importedCursorId = Object.keys(targetMeta.cursors)[0];
	assert.ok(
		importedCursorId?.startsWith("import-") &&
			importedCursorId.endsWith("-source-cursor"),
	);
	const importedCursor = targetMeta.cursors[importedCursorId];
	assert.deepEqual(importedCursor?.hotspot, { x: 4, y: 5 });
	const cursorEvents = await jsonFile<{
		moves: Array<{ cursor_id: string }>;
		clicks: Array<{ cursor_id: string }>;
	}>(join(targetProject, firstImported.cursor));
	assert.equal(cursorEvents.moves[0]?.cursor_id, importedCursorId);
	assert.equal(cursorEvents.clicks[0]?.cursor_id, importedCursorId);
	const keyboardEvents = await jsonFile<{
		presses: Array<{ keyCode: string }>;
	}>(join(targetProject, firstImported.keyboard));
	assert.equal(keyboardEvents.presses[0]?.keyCode, "KeyA");
	for (const path of [
		firstImported.display.path,
		firstImported.camera.path,
		firstImported.mic.path,
		firstImported.system_audio.path,
		importedCursor.imagePath,
	]) {
		assert.ok(await Bun.file(join(targetProject, path)).exists(), path);
	}
	const targetConfigPath = join(targetProject, "project-config.json");
	const targetConfig = await jsonFile<ProjectConfig>(targetConfigPath);
	assert.equal(targetConfig.timeline?.segments.length, 3);
	assert.deepEqual(targetConfig.timeline?.segments.slice(1), [
		{
			recordingSegment: 1,
			timescale: 1.5,
			start: 0.2,
			end: 1.6,
			speedAudioMode: "maintainPitch",
			hideCursor: false,
			volume: 0.75,
			name: null,
		},
		{
			recordingSegment: 2,
			timescale: 1,
			start: 0,
			end: 1.2,
			hideCursor: true,
			name: null,
		},
	]);
	const { stdout: probe } = await runFile("ffprobe", [
		"-v",
		"error",
		"-show_entries",
		"format=duration",
		"-of",
		"default=nw=1:nk=1",
		imported,
	]);
	const targetDuration = Number(probe.trim());
	assert.ok(Number.isFinite(targetDuration) && targetDuration > 0);
	const previewSettingsPath = join(temporary, "preview-settings.json");
	const previewPath = join(temporary, "imported-preview.jpg");
	await writeFile(
		previewSettingsPath,
		JSON.stringify({
			fps: 30,
			resolution_base: { x: 640, y: 360 },
			compression_bpp: 0.7,
		}),
	);
	await runFile(binary, [
		"preview",
		targetProject,
		targetConfigPath,
		String(targetDuration + 0.25),
		previewSettingsPath,
		previewPath,
	]);
	const preview = await readFile(previewPath);
	assert.equal(preview[0], 0xff);
	assert.equal(preview[1], 0xd8);
	assert.ok(preview.length > 1024);
	const tailPath = `content/videos/${randomUUID()}.mp4`;
	await mkdir(join(targetProject, "content/videos"), { recursive: true });
	await copyFile(imported, join(targetProject, tailPath));
	const tailManifest = join(temporary, "tail-manifest.json");
	await writeFile(
		tailManifest,
		JSON.stringify({
			version: 1,
			clips: [
				{
					displayPath: join(targetProject, tailPath),
					duration: targetDuration,
					fps: 30,
					hasAudio: true,
				},
			],
		}),
	);
	await runFile(binary, ["append-clip", targetProject, tailManifest]);
	const configWithTail = await jsonFile<ProjectConfig>(targetConfigPath);
	assert.ok(configWithTail.timeline);
	configWithTail.timeline.segments.push({
		recordingSegment: 3,
		timescale: 1,
		start: 0,
		end: targetDuration,
	});
	await writeFile(targetConfigPath, JSON.stringify(configWithTail));
	const tailMeta = await jsonFile<RecordingMeta>(
		join(targetProject, "recording-meta.json"),
	);
	assert.equal(tailMeta.segments.length, 4);
	await mkdir(join(instantProject, "content"), { recursive: true });
	await copyFile(imported, join(instantProject, "content/output.mp4"));
	await writeFile(
		join(instantProject, "recording-meta.json"),
		JSON.stringify({
			pretty_name: "Completed Instant recording",
			fps: 30,
			sample_rate: null,
		}),
	);
	const instantBundlePath = join(temporary, "instant.capbundle");
	await bundleProject(instantProject, instantBundlePath);
	const extractedInstant = await extractEditorCapBundle(instantBundlePath);
	let instantStdout = "";
	try {
		const appended = await runFile(binary, [
			"append-cap",
			targetProject,
			extractedInstant.path,
		]);
		instantStdout = appended.stdout.toString();
	} finally {
		await extractedInstant.cleanup();
	}
	assert.equal(
		(JSON.parse(instantStdout) as { clipCount: number }).clipCount,
		1,
	);
	const configWithInstant = await jsonFile<ProjectConfig>(targetConfigPath);
	const instantMeta = await jsonFile<RecordingMeta>(
		join(targetProject, "recording-meta.json"),
	);
	assert.equal(instantMeta.segments.length, 5);
	assert.equal(
		instantMeta.segments[4]?.system_audio?.path,
		instantMeta.segments[4]?.display.path,
	);
	assert.equal(configWithInstant.timeline?.segments.length, 5);
	const beforeInstant = configWithInstant.timeline?.segments
		.slice(0, -1)
		.reduce(
			(total, segment) =>
				total + (segment.end - segment.start) / segment.timescale,
			0,
		);
	assert.ok(beforeInstant !== undefined && Number.isFinite(beforeInstant));
	await runFile(binary, [
		"preview",
		targetProject,
		targetConfigPath,
		String(beforeInstant + 0.25),
		previewSettingsPath,
		join(temporary, "instant-preview.jpg"),
	]);
	const sourceBlob = Bun.file(bundlePath);
	const instantBlob = Bun.file(instantBundlePath);
	const clipBlob = Bun.file(imported);
	const etag = '"cap-bundle-replay"';
	const server = Bun.serve({
		port: 0,
		fetch(request) {
			if (request.headers.get("if-match") !== etag) {
				return new Response(null, { status: 412 });
			}
			const pathname = new URL(request.url).pathname;
			const blob =
				pathname === "/source.capbundle"
					? sourceBlob
					: pathname === "/instant.capbundle"
						? instantBlob
						: clipBlob;
			return new Response(blob, {
				headers: {
					ETag: etag,
					"Content-Length": String(blob.size),
				},
			});
		},
	});
	const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	try {
		const studioCapId = randomUUID();
		const instantCapId = randomUUID();
		const studioCapPath = `content/imports/${studioCapId}.capbundle`;
		const instantCapPath = `content/imports/${instantCapId}.capbundle`;
		let nativeStudioCaptionSegments: typeof sourceAudioSegments | null = null;
		const replay = await prepareNativeEditorProject({
			title: "Ordered Cap and MP4 import replay",
			display: {
				path: imported,
				contentType: "video/mp4",
				size: clipBlob.size,
				fps: 30,
			},
			mixedAudioInDisplay: true,
			projectConfig: configWithInstant as Record<string, unknown>,
			videoAssets: [
				{
					path: tailPath,
					name: "Tail MP4",
					url: `http://127.0.0.1:${server.port}/tail.mp4`,
					size: clipBlob.size,
					contentType: "video/mp4",
					objectIdentity: etag,
				},
			],
			imports: [
				{
					kind: "cap",
					asset: {
						path: studioCapPath,
						name: "Studio source",
						url: `http://127.0.0.1:${server.port}/source.capbundle`,
						size: sourceBlob.size,
						contentType: CAP_BUNDLE_CONTENT_TYPE,
						objectIdentity: etag,
					},
					clipCount: 2,
				},
				{
					kind: "clip",
					clip: {
						displayPath: tailPath,
						duration: targetDuration,
						fps: 30,
						hasAudio: true,
					},
				},
				{
					kind: "cap",
					asset: {
						path: instantCapPath,
						name: "Instant source",
						url: `http://127.0.0.1:${server.port}/instant.capbundle`,
						size: instantBlob.size,
						contentType: CAP_BUNDLE_CONTENT_TYPE,
						objectIdentity: etag,
					},
					clipCount: 1,
				},
			],
		});
		let nativeSession: Awaited<
			ReturnType<typeof startNativeEditorSession>
		> | null = null;
		try {
			const replayMeta = await jsonFile<RecordingMeta>(
				join(replay.path, "recording-meta.json"),
			);
			const replayConfig = await jsonFile<ProjectConfig>(
				join(replay.path, "project-config.json"),
			);
			assert.equal(replayMeta.segments.length, 5);
			assert.deepEqual(
				replayConfig.timeline?.segments,
				configWithInstant.timeline?.segments,
			);
			assert.ok(replayMeta.segments[1]?.camera?.path);
			assert.ok(replayMeta.segments[1]?.cursor);
			assert.ok(replayMeta.segments[1]?.keyboard);
			assert.ok(replayMeta.segments[3]?.display.path);
			assert.equal(
				replayMeta.segments[4]?.system_audio?.path,
				replayMeta.segments[4]?.display.path,
			);
			nativeSession = await startNativeEditorSession(replay);
			const nativeResponse = await nativeSession.request("/instance");
			assert.equal(nativeResponse.status, 200);
			const nativeInstance: unknown = await nativeResponse.json();
			const captionMetadata: VideoMetadata = {
				editorSources: {
					version: 1,
					display: {
						key: "owner/video/result.mp4",
						contentType: "video/mp4",
						size: clipBlob.size,
						objectIdentity: etag,
					},
				},
				webEditorVideos: {
					version: 1,
					items: [
						{
							key: `owner/video/editor-assets/recordings/${studioCapId}.capbundle`,
							path: studioCapPath,
							name: "Studio source",
							contentType: CAP_BUNDLE_CONTENT_TYPE,
							size: sourceBlob.size,
							objectIdentity: etag,
						},
						{
							key: `owner/video/editor-assets/videos/${tailPath.split("/").at(-1)}`,
							path: tailPath,
							name: "Tail MP4",
							contentType: "video/mp4",
							size: clipBlob.size,
							objectIdentity: etag,
						},
						{
							key: `owner/video/editor-assets/recordings/${instantCapId}.capbundle`,
							path: instantCapPath,
							name: "Instant source",
							contentType: CAP_BUNDLE_CONTENT_TYPE,
							size: instantBlob.size,
							objectIdentity: etag,
						},
					],
				},
				webEditorClips: {
					version: 1,
					items: [
						{
							displayPath: tailPath,
							duration: targetDuration,
							fps: 30,
							hasAudio: true,
						},
					],
				},
				webEditorImports: {
					version: 1,
					items: [
						{ kind: "cap", path: studioCapPath, clipCount: 2 },
						{ kind: "clip", path: tailPath },
						{ kind: "cap", path: instantCapPath, clipCount: 1 },
					],
				},
			};
			const nativeCaptionFixture = join(
				temporary,
				"native-caption-fixture.json",
			);
			await writeFile(
				nativeCaptionFixture,
				JSON.stringify({ metadata: captionMetadata, instance: nativeInstance }),
			);
			const { stdout: captionPlanOutput } = await runFile(process.execPath, [
				join(
					import.meta.dir,
					"../../../../web/__tests__/editor-caption-native-replay.ts",
				),
				nativeCaptionFixture,
			]);
			const measuredSegments = (
				JSON.parse(captionPlanOutput) as {
					studioSegments: typeof sourceAudioSegments;
				}
			).studioSegments;
			const keyboardResponse = await nativeSession.request(
				"/keyboard-segments",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						groupingThresholdMs: 350,
						lingerDurationMs: 1800,
						showModifiers: true,
						showSpecialKeys: true,
					}),
				},
			);
			assert.equal(keyboardResponse.status, 200);
			const generatedKeyboardSegments: unknown = await keyboardResponse.json();
			assert.ok(
				Array.isArray(generatedKeyboardSegments) &&
					generatedKeyboardSegments.length > 0,
			);
			const autoZoomResponse = await nativeSession.request(
				"/auto-zoom-segments",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ zoomAmount: 1.8 }),
				},
			);
			assert.equal(autoZoomResponse.status, 200);
			const generatedZoomSegments = (await autoZoomResponse.json()) as Array<{
				start: number;
				end: number;
				amount: number;
			}>;
			assert.ok(generatedZoomSegments.length > 0);
			assert.equal(generatedZoomSegments[0]?.amount, 1.8);
			assert.ok(
				(generatedZoomSegments[0]?.start ?? 0) > 1.5,
				"imported cursor clicks must zoom after the preceding source clip",
			);
			assert.equal(measuredSegments.length, sourceAudioSegments.length);
			for (const [index, measured] of measuredSegments.entries()) {
				const source = sourceAudioSegments[index];
				assert.ok(source);
				assert.ok(
					Math.abs(measured.mediaDurationMs - source.mediaDurationMs) <= 2000,
				);
				assert.ok(
					Math.abs(measured.segmentDurationMs - source.segmentDurationMs) <=
						2000,
				);
			}
			nativeStudioCaptionSegments = measuredSegments;
		} finally {
			if (nativeSession) await nativeSession.close();
			else await replay.cleanup();
		}
		assert.ok(nativeStudioCaptionSegments);
		const studioCaptionAudio = await prepareEditorCapCaptionAudio(
			{
				path: `content/imports/${randomUUID()}.capbundle`,
				name: "Studio source",
				url: `http://127.0.0.1:${server.port}/source.capbundle`,
				size: sourceBlob.size,
				contentType: CAP_BUNDLE_CONTENT_TYPE,
				objectIdentity: etag,
			},
			nativeStudioCaptionSegments,
		);
		try {
			assert.ok(studioCaptionAudio.size > 1024);
			assert.ok(
				Math.abs(
					(await durationMs(studioCaptionAudio.path)) -
						nativeStudioCaptionSegments.reduce(
							(total, segment) => total + segment.segmentDurationMs,
							0,
						),
				) <= 250,
			);
		} finally {
			await studioCaptionAudio.cleanup();
		}
		const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "cap-caption-replay-secret";
		try {
			const instantDurationMs = await durationMs(imported);
			const requestBody = JSON.stringify({
				asset: {
					path: `content/imports/${randomUUID()}.capbundle`,
					name: "Instant source",
					url: `http://127.0.0.1:${server.port}/instant.capbundle`,
					size: instantBlob.size,
					contentType: CAP_BUNDLE_CONTENT_TYPE,
					objectIdentity: etag,
				},
				segments: [
					{
						mediaDurationMs: instantDurationMs,
						segmentDurationMs: instantDurationMs,
						hasAudio: true,
					},
				],
			});
			const rejected = await editorWorkerApp.request(
				"/editor/caption-cap-audio",
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: requestBody,
				},
			);
			assert.equal(rejected.status, 401);
			const captionResponse = await editorWorkerApp.request(
				"/editor/caption-cap-audio",
				{
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						"x-media-server-secret": "cap-caption-replay-secret",
					},
					body: requestBody,
				},
			);
			assert.equal(captionResponse.status, 200);
			assert.equal(captionResponse.headers.get("content-type"), "audio/mp4");
			const captionBytes = new Uint8Array(await captionResponse.arrayBuffer());
			assert.ok(captionBytes.length > 1024);
			const captionAudioPath = join(temporary, "instant-caption-audio.m4a");
			await writeFile(captionAudioPath, captionBytes);
			const { stdout: assemblyReplayOutput } = await runFile(process.execPath, [
				join(
					import.meta.dir,
					"../../../../web/__tests__/editor-caption-assemblyai-stream-replay.ts",
				),
				captionAudioPath,
			]);
			assert.equal(
				(JSON.parse(assemblyReplayOutput) as { uploadedBytes: number })
					.uploadedBytes,
				captionBytes.length,
			);
		} finally {
			if (previousSecret === undefined) {
				delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
			} else {
				process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
			}
		}
	} finally {
		server.stop(true);
		if (previousAllowHttp === undefined) {
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		} else {
			process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
		}
	}
	process.stdout.write(
		`${JSON.stringify({
			importedClips: 4,
			orderedReplay:
				"Studio Cap, MP4, then Instant Cap, with saved timeline restored",
			preserved: [
				"webcam",
				"microphone",
				"system audio",
				"cursor events and image",
				"keyboard events",
				"source trims and speed",
				"Instant embedded audio",
			],
			previewBytes: preview.length,
		})}\n`,
	);
} finally {
	await rm(temporary, { recursive: true, force: true });
}
