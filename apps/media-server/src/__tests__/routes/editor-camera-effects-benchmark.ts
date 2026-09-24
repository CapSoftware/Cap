import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import app from "../../editor-worker-app";
import { getEditorSession } from "../../lib/editor-sessions";

const runFile = promisify(execFile);
const secret = "editor-camera-effects-benchmark-secret";
const benchmarkSeconds = 12;
const resolutionBase = { x: 1920, y: 1080 };

type NativeMetrics = {
	producedFrames: number;
	packedFrames: number;
	rawBytes: number;
	sentBytes: number;
	h264Frames: number;
	h264Bytes: number;
	h264Viewers: number;
	softwareAdapter: boolean;
	gpuAdapter: string;
};

type ExportState = {
	status: string;
	error: string | null;
	progress: { rendered_count: number; total_frames: number } | null;
	mediaMetadata: { duration: number; width: number; height: number } | null;
};

async function ffmpeg(args: string[]) {
	await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", ...args], {
		timeout: 120_000,
	});
}

async function makeSource(path: string, size: string, fps: number) {
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=${size}:rate=${fps}:duration=8`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-crf",
		"34",
		"-pix_fmt",
		"yuv420p",
		"-movflags",
		"+faststart",
		path,
	]);
}

async function loopSource(source: string, output: string) {
	await ffmpeg([
		"-stream_loop",
		"3",
		"-i",
		source,
		"-c",
		"copy",
		"-t",
		"30",
		"-movflags",
		"+faststart",
		output,
	]);
}

async function readySession(id: string, headers: Record<string, string>) {
	const deadline = Date.now() + 120_000;
	while (Date.now() < deadline) {
		const response = await app.request(`/editor/preparations/${id}`, {
			headers,
		});
		assert.equal(response.status, 200);
		const result = (await response.json()) as {
			status: string;
			sessionId?: string;
			error?: string;
		};
		if (result.status === "ready") {
			assert.ok(result.sessionId);
			return result.sessionId;
		}
		if (result.status === "error")
			throw new Error(result.error ?? "Editor preparation failed");
		await Bun.sleep(100);
	}
	throw new Error("Editor preparation timed out");
}

async function processSample(pid: number) {
	const [statText, statusText] = await Promise.all([
		readFile(`/proc/${pid}/stat`, "utf8"),
		readFile(`/proc/${pid}/status`, "utf8"),
	]);
	const fields = statText.slice(statText.lastIndexOf(") ") + 2).split(" ");
	const ticks = Number(fields[11]) + Number(fields[12]);
	const rssKilobytes = Number(statusText.match(/^VmRSS:\s+(\d+)\s+kB/m)?.[1]);
	assert.ok(Number.isFinite(ticks));
	assert.ok(Number.isFinite(rssKilobytes));
	return { ticks, rssMb: Math.round((rssKilobytes / 1024) * 10) / 10 };
}

assert.ok(process.platform === "linux");
assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
assert.equal(process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL, "1");
const { stdout: tickOutput } = await runFile("getconf", ["CLK_TCK"]);
const ticksPerSecond = Number(tickOutput.trim());
assert.ok(ticksPerSecond > 0);

const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
const root = await mkdtemp(join(tmpdir(), "cap-editor-camera-bench-"));
const headers = {
	"x-media-server-secret": secret,
	"Content-Type": "application/json",
};
let server: ReturnType<typeof Bun.serve> | null = null;
let sessionId: string | null = null;
let viewer: WebSocket | null = null;
const viewerFallbacks: string[] = [];
let viewerPackets = 0;
try {
	const displaySource = join(root, "display-source.mp4");
	const cameraSource = join(root, "camera-source.mp4");
	const display = join(root, "display.mp4");
	const camera = join(root, "camera.mp4");
	const realCameraVideo = process.env.CAP_EDITOR_CAMERA_REAL_VIDEO;
	const displayFixture = async () => {
		await makeSource(displaySource, "1920x1080", 30);
		await loopSource(displaySource, display);
	};
	const cameraFixture = async () => {
		if (realCameraVideo) {
			const source = await stat(realCameraVideo);
			assert.ok(source.isFile() && source.size > 0);
			await ffmpeg([
				"-stream_loop",
				"1",
				"-i",
				realCameraVideo,
				"-vf",
				"fps=25,scale=720:720",
				"-t",
				"30",
				"-c:v",
				"libx264",
				"-preset",
				"ultrafast",
				"-crf",
				"23",
				"-pix_fmt",
				"yuv420p",
				"-movflags",
				"+faststart",
				camera,
			]);
		} else {
			await makeSource(cameraSource, "1280x720", 25);
			await loopSource(cameraSource, camera);
		}
	};
	await Promise.all([displayFixture(), cameraFixture()]);
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/display.mp4") return new Response(Bun.file(display));
			if (path === "/camera.mp4") return new Response(Bun.file(camera));
			return new Response("Missing fixture", { status: 404 });
		},
	});
	const base = `http://127.0.0.1:${server.port}`;
	const preparation = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId: "editor-camera-effects-benchmark",
			title: "1080p screen and 720p camera effect benchmark",
			captionsEnabled: false,
			display: {
				url: `${base}/display.mp4`,
				contentType: "video/mp4",
				size: (await stat(display)).size,
				fps: 30,
			},
			camera: {
				url: `${base}/camera.mp4`,
				contentType: "video/mp4",
				size: (await stat(camera)).size,
				fps: 25,
				offsetMs: 125,
			},
		}),
	});
	assert.equal(preparation.status, 202);
	const created = (await preparation.json()) as { id: string };
	sessionId = await readySession(created.id, headers);
	const native = getEditorSession(sessionId);
	assert.ok(native?.pid);
	const pid = native.pid;
	viewer = native.connectSocket(
		`${native.origin.replace(/^http/, "ws")}/frames-h264`,
	);
	viewer.binaryType = "arraybuffer";
	viewer.addEventListener("message", (event) => {
		if (typeof event.data === "string") {
			if (event.data.includes("cap-h264-unavailable"))
				viewerFallbacks.push(event.data);
		} else viewerPackets++;
	});
	await new Promise<void>((resolve, reject) => {
		viewer?.addEventListener("open", () => resolve(), { once: true });
		viewer?.addEventListener(
			"error",
			() => reject(new Error("H.264 viewer failed")),
			{
				once: true,
			},
		);
	});
	const instance = await app.request(`/editor/sessions/${sessionId}/instance`, {
		headers,
	});
	assert.equal(instance.status, 200);
	const saved = (await instance.json()) as {
		savedProjectConfig: {
			camera: { backgroundBlur: { mode: string } };
			timeline?: Record<string, unknown> | null;
		};
	};
	const initialConfig = saved.savedProjectConfig;
	const preview = async () => {
		const started = performance.now();
		const response = await app.request(
			`/editor/sessions/${sessionId}/preview`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					frameNumber: 30,
					fps: 30,
					resolutionBase: { x: 640, y: 360 },
				}),
			},
		);
		const bytes = Buffer.from(await response.arrayBuffer());
		return {
			status: response.status,
			ms: Math.round(performance.now() - started),
			sha256:
				response.status === 200
					? createHash("sha256").update(bytes).digest("hex")
					: null,
		};
	};
	const metrics = async () => {
		const response = await native.request("/metrics");
		assert.equal(response.status, 200);
		return (await response.json()) as NativeMetrics;
	};
	const measure = async (mode: "off" | "remove") => {
		const config = structuredClone(initialConfig);
		config.camera.backgroundBlur.mode = mode;
		const update = await app.request(
			`/editor/sessions/${sessionId}/config/memory`,
			{
				method: "PUT",
				headers,
				body: JSON.stringify(config),
			},
		);
		assert.equal(update.status, 204);
		const previewResult = await preview();
		const before = await metrics();
		assert.equal(before.h264Viewers, 1);
		const processBefore = await processSample(pid);
		const started = performance.now();
		const playback = await app.request(
			`/editor/sessions/${sessionId}/playback`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({
					frameNumber: 0,
					fps: 60,
					resolutionBase,
				}),
			},
		);
		assert.equal(playback.status, 204);
		const frameSamples = [];
		let previousFrames = before.producedFrames;
		for (let second = 0; second < benchmarkSeconds; second++) {
			await Bun.sleep(1000);
			const sample = await metrics();
			frameSamples.push(sample.producedFrames - previousFrames);
			previousFrames = sample.producedFrames;
		}
		const stopped = await app.request(
			`/editor/sessions/${sessionId}/playback`,
			{ method: "DELETE", headers },
		);
		assert.equal(stopped.status, 204);
		const elapsedSeconds = (performance.now() - started) / 1000;
		const after = await metrics();
		const processAfter = await processSample(pid);
		const producedFrames = after.producedFrames - before.producedFrames;
		const warmedPreview = await preview();
		return {
			mode,
			preview: previewResult,
			warmedPreview,
			elapsedSeconds: Math.round(elapsedSeconds * 100) / 100,
			producedFrames,
			renderFps: Math.round((producedFrames / elapsedSeconds) * 10) / 10,
			frameSamples,
			packedFrames: after.packedFrames - before.packedFrames,
			rawMb: Math.round((after.rawBytes - before.rawBytes) / 1048576),
			sentMb: Math.round((after.sentBytes - before.sentBytes) / 1048576),
			h264Frames: after.h264Frames - before.h264Frames,
			h264Mb: Math.round((after.h264Bytes - before.h264Bytes) / 1048576),
			cpuCoresUsed:
				Math.round(
					((processAfter.ticks - processBefore.ticks) /
						ticksPerSecond /
						elapsedSeconds) *
						100,
				) / 100,
			nativeRssBeforeMb: processBefore.rssMb,
			nativeRssAfterMb: processAfter.rssMb,
		};
	};
	const off = await measure("off");
	const remove = await measure("remove");
	const exportConfig = structuredClone(initialConfig);
	exportConfig.camera.backgroundBlur.mode = "remove";
	exportConfig.timeline = {
		...(exportConfig.timeline ?? {}),
		segments: [{ recordingSegment: 0, timescale: 1, start: 0, end: 2 }],
	};
	const exportUpdate = await app.request(
		`/editor/sessions/${sessionId}/config`,
		{
			method: "PUT",
			headers,
			body: JSON.stringify(exportConfig),
		},
	);
	assert.equal(exportUpdate.status, 204);
	const savedConfigResponse = await app.request(
		`/editor/sessions/${sessionId}/config`,
		{ headers },
	);
	assert.equal(savedConfigResponse.status, 200);
	const savedConfig = (await savedConfigResponse.json()) as typeof exportConfig;
	const savedTimeline = savedConfig.timeline as
		| { segments: Array<{ end: number }> }
		| null
		| undefined;
	assert.equal(savedConfig.camera.backgroundBlur.mode, "remove");
	assert.equal(savedTimeline?.segments[0]?.end, 2);
	const previewResponse = await app.request(
		`/editor/sessions/${sessionId}/preview`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				frameNumber: 30,
				fps: 30,
				resolutionBase: { x: 640, y: 360 },
			}),
		},
	);
	assert.equal(previewResponse.status, 200);
	const rgbaPixels = async (response: Response) => {
		assert.equal(response.status, 200);
		const bytes = Buffer.from(await response.arrayBuffer());
		const footer = bytes.length - 24;
		assert.equal(bytes.length, 640 * 360 * 4 + 24);
		assert.equal(bytes.readUInt32LE(footer), 640 * 4);
		assert.equal(bytes.readUInt32LE(footer + 4), 360);
		assert.equal(bytes.readUInt32LE(footer + 8), 640);
		assert.equal(bytes.readUInt32LE(footer + 12), 30);
		return bytes.subarray(0, footer);
	};
	const previewPath = join(root, "camera-removal-preview.rgba");
	await writeFile(previewPath, await rgbaPixels(previewResponse));
	const offConfig = structuredClone(exportConfig);
	offConfig.camera.backgroundBlur.mode = "off";
	const offUpdate = await app.request(
		`/editor/sessions/${sessionId}/config/memory`,
		{ method: "PUT", headers, body: JSON.stringify(offConfig) },
	);
	assert.equal(offUpdate.status, 204);
	const offPreviewResponse = await app.request(
		`/editor/sessions/${sessionId}/preview`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				frameNumber: 30,
				fps: 30,
				resolutionBase: { x: 640, y: 360 },
			}),
		},
	);
	const offPreviewPath = join(root, "camera-off-preview.rgba");
	await writeFile(offPreviewPath, await rgbaPixels(offPreviewResponse));
	const removeUpdate = await app.request(
		`/editor/sessions/${sessionId}/config/memory`,
		{ method: "PUT", headers, body: JSON.stringify(exportConfig) },
	);
	assert.equal(removeUpdate.status, 204);
	const exportResponse = await app.request(
		`/editor/sessions/${sessionId}/exports`,
		{
			method: "POST",
			headers,
			body: JSON.stringify({
				format: "Mp4",
				fps: 30,
				resolution_base: { x: 640, y: 360 },
				compression: "Social",
				custom_bpp: null,
				force_ffmpeg_decoder: true,
				optimize_filesize: false,
			}),
		},
	);
	assert.equal(exportResponse.status, 202);
	const exportId = ((await exportResponse.json()) as { id: string }).id;
	let exportState: ExportState | null = null;
	const exportDeadline = Date.now() + 120_000;
	while (Date.now() < exportDeadline) {
		const response = await app.request(
			`/editor/sessions/${sessionId}/exports/${exportId}`,
			{ headers },
		);
		assert.equal(response.status, 200);
		exportState = (await response.json()) as ExportState;
		if (exportState?.status === "ready") break;
		if (exportState?.status === "error")
			throw new Error(exportState.error ?? "Camera removal export failed");
		await Bun.sleep(100);
	}
	if (!exportState || exportState.status !== "ready")
		throw new Error("Camera removal export timed out");
	assert.equal(exportState.progress?.rendered_count, 60);
	assert.equal(exportState.progress?.total_frames, 60);
	assert.equal(exportState.mediaMetadata?.width, 640);
	assert.equal(exportState.mediaMetadata?.height, 360);
	const fileResponse = await app.request(
		`/editor/sessions/${sessionId}/exports/${exportId}/file`,
		{ headers },
	);
	assert.equal(fileResponse.status, 200);
	const exportPath = join(root, "camera-removal-export.mp4");
	await writeFile(exportPath, Buffer.from(await fileResponse.arrayBuffer()));
	const exportFramePath = join(root, "camera-removal-export-frame.png");
	await ffmpeg([
		"-i",
		exportPath,
		"-vf",
		"select=eq(n\\,30)",
		"-frames:v",
		"1",
		exportFramePath,
	]);
	const exportPsnr = async (sourcePath: string) => {
		const { stderr } = await runFile("ffmpeg", [
			"-hide_banner",
			"-loglevel",
			"info",
			"-f",
			"rawvideo",
			"-pixel_format",
			"rgba",
			"-video_size",
			"640x360",
			"-i",
			sourcePath,
			"-i",
			exportFramePath,
			"-lavfi",
			"psnr",
			"-f",
			"null",
			"-",
		]);
		return Number(stderr.match(/average:([0-9.]+)/)?.[1]);
	};
	const exportPsnrDb = await exportPsnr(previewPath);
	const offExportPsnrDb = await exportPsnr(offPreviewPath);
	assert.ok(Number.isFinite(exportPsnrDb));
	assert.ok(Number.isFinite(offExportPsnrDb));
	assert.ok(exportPsnrDb >= 20);
	assert.ok(exportPsnrDb > offExportPsnrDb + 3);
	const artifactDir = process.env.CAP_EDITOR_CAMERA_BENCH_ARTIFACT_DIR;
	if (artifactDir) {
		await mkdir(artifactDir, { recursive: true });
		for (const path of [
			previewPath,
			offPreviewPath,
			exportFramePath,
			exportPath,
		])
			await copyFile(path, join(artifactDir, basename(path)));
	}
	const removalSha256 = remove.preview.sha256 ?? remove.warmedPreview?.sha256;
	if (off.preview.sha256 && removalSha256)
		assert.notEqual(off.preview.sha256, removalSha256);
	const adapter = await metrics();
	process.stdout.write(
		`${JSON.stringify({
			sources: {
				display: "1920x1080@30",
				camera: realCameraVideo ? "720x720@25 real subject" : "1280x720@25",
			},
			requestedFps: 60,
			softwareAdapter: adapter.softwareAdapter,
			gpuAdapter: adapter.gpuAdapter,
			workerRssMb: Math.round(process.memoryUsage().rss / 1048576),
			viewerPackets,
			viewerFallbacks,
			off,
			remove,
			export: {
				frames: exportState.progress?.rendered_count,
				duration: exportState.mediaMetadata?.duration,
				previewToMp4PsnrDb: exportPsnrDb,
				offPreviewToMp4PsnrDb: offExportPsnrDb,
			},
		})}\n`,
	);
	for (const result of [off, remove]) {
		assert.equal(result.preview.status, 200);
		assert.equal(result.warmedPreview.status, 200);
	}
	assert.deepEqual(viewerFallbacks, []);
} finally {
	viewer?.close();
	if (sessionId)
		await app.request(`/editor/sessions/${sessionId}`, {
			method: "DELETE",
			headers,
		});
	server?.stop(true);
	await rm(root, { recursive: true, force: true });
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
	if (previousAllowHttp === undefined)
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
}
