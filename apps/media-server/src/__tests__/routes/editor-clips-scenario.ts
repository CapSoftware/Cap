import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import app from "../../editor-worker-app";
import { getEditorSession } from "../../lib/editor-sessions";
import {
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

type ExportResult = {
	status: string;
	error: string | null;
	size: number | null;
	mediaMetadata: { duration: number } | null;
	progress: { rendered_count: number; total_frames: number } | null;
};

async function waitForPreparation(id: string, headers: Record<string, string>) {
	const deadline = Date.now() + 60_000;
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
			throw new Error(result.error ?? "Native preparation failed");
		await Bun.sleep(100);
	}
	throw new Error("Native preparation timed out");
}

async function waitForExport(
	sessionId: string,
	exportId: string,
	headers: Record<string, string>,
) {
	const deadline = Date.now() + 60_000;
	while (Date.now() < deadline) {
		const response = await app.request(
			`/editor/sessions/${sessionId}/exports/${exportId}`,
			{ headers },
		);
		assert.equal(response.status, 200);
		const result = (await response.json()) as ExportResult;
		if (result.status === "ready") return result;
		if (result.status === "error")
			throw new Error(result.error ?? "Native export failed");
		await Bun.sleep(100);
	}
	throw new Error("Native export timed out");
}

async function previewColor(
	sessionId: string,
	frameNumber: number,
	headers: Record<string, string>,
) {
	const response = await app.request(`/editor/sessions/${sessionId}/preview`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			frameNumber,
			fps: 30,
			resolutionBase: { x: 640, y: 360 },
		}),
	});
	assert.equal(response.status, 200);
	const bytes = Buffer.from(await response.arrayBuffer());
	const stride = bytes.readUInt32LE(bytes.length - 24);
	const offset = 180 * stride + 320 * 4;
	return { red: bytes[offset] ?? 0, blue: bytes[offset + 2] ?? 0 };
}

export async function replayEditorClips() {
	assert.ok(process.env.CAP_WEB_EDITOR_PREPARE_BIN);
	assert.ok(process.env.CAP_WEB_EDITOR_SERVICE_BIN);
	const secret = "editor-clips-test-secret";
	const previousSecret = process.env.MEDIA_SERVER_WEBHOOK_SECRET;
	const previousAllowHttp = process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	const previousPublicOrigin = process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
	process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
	const fixtures = join(import.meta.dir, "../fixtures/editor-clips");
	const original = join(fixtures, "display-red.webm");
	const imported = join(fixtures, "clip-blue-audio.mp4");
	const camera = join(fixtures, "camera-green.webm");
	const paths = new Map([
		["/original.webm", original],
		["/imported.mp4", imported],
		["/camera.webm", camera],
	]);
	let server: ReturnType<typeof Bun.serve> | null = null;
	let socketServer: ReturnType<typeof Bun.serve> | null = null;
	let frameSocket: WebSocket | null = null;
	let sessionId: string | null = null;
	try {
		server = Bun.serve({
			port: 0,
			fetch(request) {
				const path = paths.get(new URL(request.url).pathname);
				return path
					? new Response(Bun.file(path))
					: new Response("Missing fixture", { status: 404 });
			},
		});
		const headers = {
			"x-media-server-secret": secret,
			"Content-Type": "application/json",
		};
		const displayPath = `content/videos/${randomUUID()}.mp4`;
		const cameraPath = `content/videos/${randomUUID()}.webm`;
		const base = `http://127.0.0.1:${server.port}`;
		const preparation = await app.request("/editor/preparations", {
			method: "POST",
			headers,
			body: JSON.stringify({
				videoId: "saved-clip-fixture",
				title: "Saved two clip project",
				display: {
					url: `${base}/original.webm`,
					contentType: "video/webm",
					size: (await stat(original)).size,
					fps: 30,
				},
				videoAssets: [
					{
						path: displayPath,
						name: "Imported clip",
						url: `${base}/imported.mp4`,
						size: (await stat(imported)).size,
						contentType: "video/mp4",
					},
					{
						path: cameraPath,
						name: "Separate camera",
						url: `${base}/camera.webm`,
						size: (await stat(camera)).size,
						contentType: "video/webm",
					},
				],
				clips: [
					{
						displayPath,
						duration: 2,
						fps: 30,
						hasAudio: true,
						cameraPath,
						cameraFps: 25,
						cameraOffsetMs: 125,
					},
				],
				projectConfig: {
					camera: { hide: true },
					timeline: {
						segments: [
							{ recordingSegment: 0, timescale: 1, start: 0, end: 3 },
							{ recordingSegment: 1, timescale: 1, start: 0, end: 2 },
						],
						zoomSegments: [],
					},
				},
			}),
		});
		assert.equal(preparation.status, 202);
		const created = (await preparation.json()) as { id: string };
		sessionId = await waitForPreparation(created.id, headers);
		const instanceResponse = await app.request(
			`/editor/sessions/${sessionId}/instance`,
			{ headers },
		);
		assert.equal(instanceResponse.status, 200);
		const instance = (await instanceResponse.json()) as {
			recordings: {
				segments: Array<{
					camera: {
						duration: number;
						fps: number;
						start_time: number;
					} | null;
					system_audio: { sample_rate: number } | null;
				}>;
			};
			savedProjectConfig: { timeline: { segments: unknown[] } };
		};
		assert.equal(instance.recordings.segments.length, 2);
		assert.equal(instance.recordings.segments[1]?.camera?.fps, 25);
		assert.ok(
			Math.abs((instance.recordings.segments[1]?.camera?.duration ?? 0) - 2) <
				0.1,
		);
		assert.ok(
			Math.abs(
				(instance.recordings.segments[1]?.camera?.start_time ?? 0) - 0.125,
			) < 0.001,
		);
		assert.equal(
			instance.recordings.segments[1]?.system_audio?.sample_rate,
			48_000,
		);
		assert.equal(instance.savedProjectConfig.timeline.segments.length, 2);
		const projectPath = getEditorSession(sessionId)?.projectPath;
		assert.ok(projectPath);
		assert.ok(
			(await stat(join(projectPath, "content/segments/segment-1/display.mp4")))
				.size > 10_000,
		);
		assert.ok(
			(await stat(join(projectPath, "content/segments/segment-1/camera.webm")))
				.size > 1_000,
		);
		const first = await previewColor(sessionId, 30, headers);
		const second = await previewColor(sessionId, 120, headers);
		assert.ok(first.red - first.blue > 100);
		assert.ok(second.blue - second.red > 100);
		socketServer = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request, listener) {
				const upgrade = handleEditorSocketUpgrade(request, listener);
				return upgrade === null ? app.fetch(request) : upgrade;
			},
			websocket: editorWebSocketHandler,
		});
		process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = `http://127.0.0.1:${socketServer.port}`;
		const ticketResponse = await app.request(
			`/editor/sessions/${sessionId}/sockets`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ origin: "http://127.0.0.1:3000" }),
			},
		);
		assert.equal(ticketResponse.status, 200);
		const socketTicket = (await ticketResponse.json()) as {
			sockets: { frames: { url: string; ticket: string } };
		};
		assert.equal(
			new URL(socketTicket.sockets.frames.url).pathname,
			`/editor/sessions/${sessionId}/frames`,
		);
		const BunWebSocket = WebSocket as unknown as new (
			url: string,
			options: Bun.WebSocketOptions,
		) => WebSocket;
		frameSocket = new BunWebSocket(socketTicket.sockets.frames.url, {
			protocols: [
				"cap-editor-v1",
				`cap-editor-ticket.${socketTicket.sockets.frames.ticket}`,
			],
			headers: { Origin: "http://127.0.0.1:3000" },
		});
		frameSocket.binaryType = "arraybuffer";
		const socketFrame = await new Promise<ArrayBuffer>((resolve, reject) => {
			const timer = setTimeout(
				() => reject(new Error("Editor frame socket timed out")),
				5000,
			);
			if (!frameSocket) return reject(new Error("Missing editor frame socket"));
			frameSocket.onmessage = (event: MessageEvent<unknown>) => {
				clearTimeout(timer);
				if (event.data instanceof ArrayBuffer) resolve(event.data);
				else reject(new Error("Editor frame was not binary"));
			};
			frameSocket.onerror = () => {
				clearTimeout(timer);
				reject(new Error("Editor frame socket failed"));
			};
		});
		assert.ok(socketFrame.byteLength > 1000);
		assert.equal(
			new TextDecoder().decode(new Uint8Array(socketFrame).subarray(0, 8)),
			"CAPPNG01",
		);
		frameSocket.close();
		frameSocket = null;
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
		const exportResult = await waitForExport(sessionId, exportId, headers);
		assert.ok((exportResult.mediaMetadata?.duration ?? 0) > 4.5);
		assert.ok((exportResult.size ?? 0) > 20_000);
		assert.equal(exportResult.progress?.rendered_count, 150);
		assert.equal(exportResult.progress?.total_frames, 150);
		const downloadTicketResponse = await app.request(
			`/editor/sessions/${sessionId}/exports/${exportId}/download-ticket`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ fileName: "paired-clips.mp4" }),
			},
		);
		assert.equal(downloadTicketResponse.status, 200);
		const downloadTicket = (await downloadTicketResponse.json()) as {
			url: string;
		};
		const downloadUrl = new URL(downloadTicket.url);
		assert.equal(
			downloadUrl.pathname,
			`/editor/sessions/${sessionId}/exports/${exportId}/download`,
		);
		const downloadResponse = await app.request(
			`${downloadUrl.pathname}${downloadUrl.search}`,
		);
		assert.equal(downloadResponse.status, 200);
		assert.ok((await downloadResponse.arrayBuffer()).byteLength > 20_000);
		return {
			clips: instance.recordings.segments.length,
			duration: exportResult.mediaMetadata?.duration,
			cameraOffset: instance.recordings.segments[1]?.camera?.start_time,
			frames: exportResult.progress?.rendered_count,
		};
	} finally {
		frameSocket?.close();
		socketServer?.stop(true);
		if (sessionId)
			await app.request(`/editor/sessions/${sessionId}`, {
				method: "DELETE",
				headers: { "x-media-server-secret": secret },
			});
		server?.stop(true);
		if (previousSecret === undefined)
			delete process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		else process.env.MEDIA_SERVER_WEBHOOK_SECRET = previousSecret;
		if (previousAllowHttp === undefined)
			delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
		else process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = previousAllowHttp;
		if (previousPublicOrigin === undefined)
			delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
		else process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN = previousPublicOrigin;
	}
}
