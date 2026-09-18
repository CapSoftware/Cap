import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAP_BUNDLE_CONTENT_TYPE,
	CAP_BUNDLE_HEADER_BYTES,
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";
import app from "../../app";
import { extractEditorCapBundle } from "../../lib/editor-cap-bundle";
import { startNativeEditorSession } from "../../lib/editor-native";

if (
	!process.env.CAP_WEB_EDITOR_PREPARE_BIN ||
	!process.env.CAP_WEB_EDITOR_SERVICE_BIN
)
	throw new Error("Native editor test binaries are unavailable");

const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
const previousOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
const previousHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
const secret = `bundle-replay-${randomUUID()}`;
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";

const root = await mkdtemp(join(tmpdir(), "cap-editor-bundle-replay-"));
const inputCap = process.env.CAP_WEB_EDITOR_BUNDLE_SOURCE;
const displayPath = inputCap
	? join(inputCap, "content/segments/segment-0/display.mp4")
	: join(root, "display.mp4");
const cameraPath = inputCap
	? join(inputCap, "content/segments/segment-0/camera.mp4")
	: join(root, "camera.mp4");
const headers = {
	"x-media-server-secret": secret,
	"Content-Type": "application/json",
};
let fixture: ReturnType<typeof Bun.serve> | null = null;
let sessionId: string | null = null;
let extracted: Awaited<ReturnType<typeof extractEditorCapBundle>> | null = null;
let replay: Awaited<ReturnType<typeof startNativeEditorSession>> | null = null;

try {
	if (!inputCap) {
		for (const [path, source, rate] of [
			[displayPath, "testsrc2=size=640x360:rate=30:duration=3", "30"],
			[cameraPath, "testsrc2=size=320x180:rate=25:duration=3", "25"],
		]) {
			const result = spawnSync(
				"ffmpeg",
				[
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					source,
					"-c:v",
					"libx264",
					"-pix_fmt",
					"yuv420p",
					"-r",
					rate,
					path,
				],
				{ encoding: "utf8" },
			);
			assert.equal(result.status, 0, result.stderr);
		}
	}
	const [display, camera] = await Promise.all([
		stat(displayPath),
		stat(cameraPath),
	]);
	fixture = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/display.mp4") return new Response(Bun.file(displayPath));
			if (path === "/camera.mp4") return new Response(Bun.file(cameraPath));
			return new Response("Not found", { status: 404 });
		},
	});
	process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = `http://127.0.0.1:${fixture.port}`;
	const prepared = await app.request("/editor/preparations", {
		method: "POST",
		headers,
		body: JSON.stringify({
			videoId: randomUUID(),
			title: "Paired bundle replay",
			display: {
				url: `http://127.0.0.1:${fixture.port}/display.mp4`,
				contentType: "video/mp4",
				size: display.size,
				fps: 30,
			},
			camera: {
				url: `http://127.0.0.1:${fixture.port}/camera.mp4`,
				contentType: "video/mp4",
				size: camera.size,
				fps: inputCap ? 30 : 25,
				offsetMs: -100,
			},
		}),
	});
	if (prepared.status !== 202)
		throw new Error(`Editor preparation failed: ${await prepared.text()}`);
	const preparationId = ((await prepared.json()) as { id: string }).id;
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const status = await app.request(`/editor/preparations/${preparationId}`, {
			headers,
		});
		assert.equal(status.status, 200);
		const value = (await status.json()) as {
			status: string;
			sessionId?: string;
			error?: string;
		};
		if (value.status === "error")
			throw new Error(value.error || "Native editor preparation failed");
		if (value.status === "ready") {
			sessionId = value.sessionId ?? null;
			break;
		}
		await Bun.sleep(100);
	}
	assert.ok(sessionId, "Native editor preparation timed out");
	const bundlePath = `/editor/sessions/${sessionId}/project-bundle`;
	const forbidden = await app.request(`${bundlePath}/download-ticket`, {
		method: "POST",
		body: "{}",
	});
	assert.equal(forbidden.status, 401);
	const snapshotStart = performance.now();
	const ticketResponse = await app.request(`${bundlePath}/download-ticket`, {
		method: "POST",
		headers,
		body: JSON.stringify({ fileName: "Paired bundle replay.capbundle" }),
	});
	if (ticketResponse.status !== 200)
		throw new Error(
			`Editor bundle ticket failed: ${await ticketResponse.text()}`,
		);
	const snapshotMs = performance.now() - snapshotStart;
	const url = new URL(((await ticketResponse.json()) as { url: string }).url);
	assert.equal(url.pathname, `${bundlePath}/download`);
	const closed = await app.request(`/editor/sessions/${sessionId}`, {
		method: "DELETE",
		headers,
	});
	assert.equal(closed.status, 204);
	const streamStart = performance.now();
	const downloaded = await app.request(`${url.pathname}${url.search}`);
	assert.equal(downloaded.status, 200);
	assert.equal(downloaded.headers.get("Content-Type"), CAP_BUNDLE_CONTENT_TYPE);
	const bytes = Buffer.from(await downloaded.arrayBuffer());
	const streamMs = performance.now() - streamStart;
	assert.equal(
		downloaded.headers.get("Content-Length"),
		String(bytes.byteLength),
	);
	assert.equal((await app.request(`${url.pathname}${url.search}`)).status, 404);
	const manifestLength = readCapBundleManifestLength(
		bytes.subarray(0, CAP_BUNDLE_HEADER_BYTES),
	);
	assert.ok(manifestLength);
	const manifest = parseCapBundleManifest(
		bytes.subarray(
			CAP_BUNDLE_HEADER_BYTES,
			CAP_BUNDLE_HEADER_BYTES + manifestLength,
		),
		bytes.byteLength,
	);
	assert.ok(manifest);
	assert.ok(
		manifest.files.some(
			(file) => file.path === "content/segments/segment-0/display.mp4",
		),
	);
	assert.ok(
		manifest.files.some(
			(file) => file.path === "content/segments/segment-0/camera.mp4",
		),
	);
	const archivePath = join(root, "download.capbundle");
	await writeFile(archivePath, bytes);
	extracted = await extractEditorCapBundle(archivePath);
	replay = await startNativeEditorSession(extracted);
	const instance = await replay.request("/instance");
	assert.equal(instance.status, 200);
	const instanceData = (await instance.json()) as { recordingDuration: number };
	assert.ok(instanceData.recordingDuration > 2);
	const preview = await replay.request("/preview", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			frameNumber: 30,
			fps: 30,
			resolutionBase: { x: 640, y: 360 },
		}),
	});
	if (preview.status !== 200)
		throw new Error(`Editor replay preview failed: ${await preview.text()}`);
	const frameBytes = (await preview.arrayBuffer()).byteLength;
	assert.ok(frameBytes > 600_000);
	console.log(
		JSON.stringify({
			bundleBytes: bytes.byteLength,
			files: manifest.files.length,
			frameBytes,
			snapshotMs: Math.round(snapshotMs),
			streamMs: Math.round(streamMs),
		}),
	);
} finally {
	await replay?.close();
	if (!replay) await extracted?.cleanup();
	if (sessionId)
		await app.request(`/editor/sessions/${sessionId}`, {
			method: "DELETE",
			headers,
		});
	fixture?.stop();
	await rm(root, { recursive: true, force: true });
	if (previousSecret === undefined)
		delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
	if (previousOrigin === undefined)
		delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	else process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = previousOrigin;
	if (previousHttp === undefined)
		delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousHttp;
}
