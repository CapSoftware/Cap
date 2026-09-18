import { afterAll, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CAP_BUNDLE_HEADER_BYTES,
	parseCapBundleManifest,
	readCapBundleManifestLength,
} from "@cap/editor-cap-bundle";
import app from "../../editor-worker-app";
import { getEditorSession } from "../../lib/editor-sessions";
import { editorWallpaperDirectory } from "../../lib/editor-wallpapers";
import {
	editorWebSocketHandler,
	handleEditorSocketUpgrade,
} from "../../lib/editor-websocket";

const secret = "editor-route-test-secret";
process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;

afterAll(() => {
	delete process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA;
	delete process.env.CAP_WEB_EDITOR_PUBLIC_ORIGIN;
});

test("the editor session endpoint rejects unauthenticated media requests", async () => {
	const response = await app.request("/editor/preparations", {
		method: "POST",
		body: JSON.stringify({}),
	});
	expect(response.status).toBe(401);
});

test("the editor session endpoint rejects incomplete paired sources", async () => {
	const response = await app.request("/editor/preparations", {
		method: "POST",
		headers: {
			"x-media-server-secret": secret,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			videoId: "test",
			title: "Test",
			display: {
				url: "https://cap.so/display.webm",
				contentType: "video/webm",
				size: 100,
				fps: 30,
			},
			camera: {
				url: "https://cap.so/camera.webm",
				contentType: "video/webm",
				size: 100,
				fps: 25,
				offsetMs: 30_001,
			},
		}),
	});
	expect(response.status).toBe(400);
	const duplicatedCamera = await app.request("/editor/preparations", {
		method: "POST",
		headers: {
			"x-media-server-secret": secret,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			videoId: "test",
			title: "Test",
			display: {
				url: "https://cap.so/original.mp4",
				contentType: "video/mp4",
				size: 100,
				fps: 30,
			},
			camera: {
				url: "https://cap.so/camera.webm",
				contentType: "video/webm",
				size: 100,
				fps: 25,
				offsetMs: 0,
			},
			legacyEditSpec: {
				version: 1,
				sourceDuration: 4,
				keepRanges: [{ start: 0, end: 2 }],
			},
		}),
	});
	expect(duplicatedCamera.status).toBe(400);
});

const hasNativeBinaries =
	!!process.env.CAP_WEB_EDITOR_PREPARE_BIN &&
	!!process.env.CAP_WEB_EDITOR_SERVICE_BIN;

test.skipIf(!hasNativeBinaries)(
	"a paired source reaches native preview and is released after closing",
	async () => {
		process.env.CAP_WEB_EDITOR_ALLOW_HTTP_MEDIA = "1";
		const root = await mkdtemp(join(tmpdir(), "cap-editor-route-test-"));
		const displayPath = join(root, "display.webm");
		const cameraPath = join(root, "camera.webm");
		const importedAudioPath = join(root, "imported.mp3");
		const importedImagePath = join(root, "overlay.png");
		const importedVideoPath = join(root, "overlay.mp4");
		let server: ReturnType<typeof Bun.serve> | null = null;
		let socketServer: ReturnType<typeof Bun.serve> | null = null;
		let socket: WebSocket | null = null;
		let commandSocket: WebSocket | null = null;
		let sessionId: string | null = null;
		try {
			for (const [path, size, fps] of [
				[displayPath, "640x360", "30"],
				[cameraPath, "320x180", "25"],
			]) {
				const result = Bun.spawn(
					[
						"ffmpeg",
						"-hide_banner",
						"-loglevel",
						"error",
						"-f",
						"lavfi",
						"-i",
						`testsrc2=size=${size}:rate=${fps}:duration=3`,
						...(path === displayPath
							? [
									"-f",
									"lavfi",
									"-i",
									"sine=frequency=440:sample_rate=48000:duration=3",
									"-c:a",
									"libopus",
								]
							: []),
						"-c:v",
						"libvpx",
						"-b:v",
						"500k",
						path,
					],
					{ stderr: "pipe" },
				);
				const [exitCode, stderr] = await Promise.all([
					result.exited,
					new Response(result.stderr).text(),
				]);
				if (exitCode !== 0) {
					throw new Error(stderr || "FFmpeg fixture generation failed");
				}
			}
			const importedAudioFixture = Bun.spawn(
				[
					"ffmpeg",
					"-hide_banner",
					"-loglevel",
					"error",
					"-f",
					"lavfi",
					"-i",
					"sine=frequency=1200:sample_rate=48000:duration=3",
					"-c:a",
					"libmp3lame",
					importedAudioPath,
				],
				{ stderr: "pipe" },
			);
			const [audioFixtureExit, audioFixtureError] = await Promise.all([
				importedAudioFixture.exited,
				new Response(importedAudioFixture.stderr).text(),
			]);
			if (audioFixtureExit !== 0) {
				throw new Error(audioFixtureError || "Audio fixture generation failed");
			}
			const imageFixture = spawnSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=magenta:s=120x80:duration=1",
				"-frames:v",
				"1",
				"-threads",
				"1",
				importedImagePath,
			]);
			expect(imageFixture.status).toBe(0);
			const videoFixture = spawnSync("ffmpeg", [
				"-v",
				"error",
				"-f",
				"lavfi",
				"-i",
				"color=c=green:s=320x180:r=30:d=3",
				"-f",
				"lavfi",
				"-i",
				"sine=frequency=660:sample_rate=48000:duration=3",
				"-c:v",
				"libx264",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				importedVideoPath,
			]);
			expect(videoFixture.status).toBe(0);
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const path = new URL(request.url).pathname;
					if (path === "/display.webm")
						return new Response(Bun.file(displayPath));
					if (path === "/camera.webm")
						return new Response(Bun.file(cameraPath));
					if (path === "/imported.mp3")
						return new Response(Bun.file(importedAudioPath));
					if (path === "/overlay.png")
						return new Response(Bun.file(importedImagePath));
					if (path === "/overlay.mp4")
						return new Response(Bun.file(importedVideoPath));
					return new Response("Not found", { status: 404 });
				},
			});
			const headers = {
				"x-media-server-secret": secret,
				"Content-Type": "application/json",
			};
			const sources = {
				videoId: "test-paired",
				title: "Paired test",
				display: {
					url: `http://127.0.0.1:${server.port}/display.webm`,
					contentType: "video/webm",
					size: (await stat(displayPath)).size,
					fps: 30,
				},
				camera: {
					url: `http://127.0.0.1:${server.port}/camera.webm`,
					contentType: "video/webm",
					size: (await stat(cameraPath)).size,
					fps: 25,
					offsetMs: -120,
				},
			};
			const response = await app.request("/editor/preparations", {
				method: "POST",
				headers,
				body: JSON.stringify(sources),
			});
			expect(response.status).toBe(202);
			const created = (await response.json()) as { id: string };
			let readySessionId: string | null = null;
			const deadline = Date.now() + 10_000;
			while (Date.now() < deadline) {
				const pending = await app.request(
					`/editor/preparations/${created.id}`,
					{ headers },
				);
				const state = (await pending.json()) as {
					status: string;
					sessionId?: string;
				};
				if (state.status === "ready") {
					readySessionId = state.sessionId ?? null;
					break;
				}
				if (state.status === "error")
					throw new Error("Native preparation failed");
				await Bun.sleep(50);
			}
			expect(readySessionId).not.toBeNull();
			if (!readySessionId) throw new Error("Native preparation has no session");
			sessionId = readySessionId;
			const instance = await app.request(
				`/editor/sessions/${sessionId}/instance`,
				{ headers },
			);
			expect(instance.status).toBe(200);
			const data = (await instance.json()) as {
				recordingDuration: number;
				path: string;
				savedProjectConfig: {
					camera: {
						mirror: boolean;
						backgroundBlur: { mode: "off" | "light" | "heavy" | "remove" };
					};
					background: {
						source: { type: string; path?: string };
					};
					timeline: {
						audioSegments: Array<{
							start: number;
							end: number;
							track: number;
							path: string;
							name: string;
							enabled: boolean;
							trimStart: number;
							volumeDb: number;
							fadeIn: number;
							fadeOut: number;
							duration: number;
						}>;
						imageSegments: Array<{
							start: number;
							end: number;
							track: number;
							path: string;
							name: string;
							enabled: boolean;
							center: { x: number; y: number };
							size: { x: number; y: number };
							opacity: number;
							rotation: number;
							flipX: boolean;
							flipY: boolean;
							lockAspect: boolean;
						}>;
					};
				};
			};
			expect(data.recordingDuration).toBeGreaterThan(2.8);
			const titlePath = `/editor/sessions/${sessionId}/meta`;
			const initialTitle = await app.request(titlePath, { headers });
			expect(initialTitle.status).toBe(200);
			expect(
				((await initialTitle.json()) as { pretty_name: string }).pretty_name,
			).toBe("Paired test");
			for (const prettyName of ["Tiny", "  Trimmed title", "Bad\u0007title"]) {
				const invalidTitle = await app.request(titlePath, {
					method: "PUT",
					headers,
					body: JSON.stringify({ prettyName }),
				});
				expect(invalidTitle.status).toBe(400);
			}
			const renamed = await app.request(titlePath, {
				method: "PUT",
				headers,
				body: JSON.stringify({ prettyName: "Renamed paired recording" }),
			});
			expect(renamed.status).toBe(204);
			const renamedTitle = await app.request(titlePath, { headers });
			expect(renamedTitle.status).toBe(200);
			expect(
				((await renamedTitle.json()) as { pretty_name: string }).pretty_name,
			).toBe("Renamed paired recording");
			const persistedTitle = JSON.parse(
				await Bun.file(join(data.path, "recording-meta.json")).text(),
			) as { pretty_name: string };
			expect(persistedTitle.pretty_name).toBe("Renamed paired recording");
			const configPath = join(data.path, "project-config.json");
			const diskBefore = await Bun.file(configPath).text();
			const paidConfig = {
				...data.savedProjectConfig,
				captions: { segments: [], settings: { enabled: true } },
			};
			for (const suffix of ["config", "config/memory"]) {
				const paidWrite = await app.request(
					`/editor/sessions/${sessionId}/${suffix}`,
					{
						method: "PUT",
						headers,
						body: JSON.stringify(paidConfig),
					},
				);
				expect(paidWrite.status).toBe(403);
			}
			expect(await Bun.file(configPath).text()).toBe(diskBefore);
			const preview = await app.request(
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
			expect(preview.status).toBe(200);
			const initialPreviewBytes = Buffer.from(await preview.arrayBuffer());
			expect(initialPreviewBytes.length).toBeGreaterThan(600_000);
			if (process.env.CAP_WEB_EDITOR_ENABLE_CAMERA_REMOVAL === "1") {
				const removalConfig = structuredClone(data.savedProjectConfig);
				removalConfig.camera.backgroundBlur.mode = "remove";
				const removalUpdate = await app.request(
					`/editor/sessions/${sessionId}/config/memory`,
					{
						method: "PUT",
						headers,
						body: JSON.stringify(removalConfig),
					},
				);
				expect(removalUpdate.status).toBe(204);
				const removalPreview = await app.request(
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
				expect(removalPreview.status).toBe(200);
				const removalBytes = Buffer.from(await removalPreview.arrayBuffer());
				expect(removalBytes.equals(initialPreviewBytes)).toBe(false);
				const restore = await app.request(
					`/editor/sessions/${sessionId}/config/memory`,
					{
						method: "PUT",
						headers,
						body: JSON.stringify(data.savedProjectConfig),
					},
				);
				expect(restore.status).toBe(204);
			}
			const wallpaperId =
				"cap-web-wallpaper://assets/backgrounds/macOS/tahoe-dusk-min.jpg";
			const wallpaperConfig = structuredClone(data.savedProjectConfig);
			wallpaperConfig.background.source = {
				type: "wallpaper",
				path: wallpaperId,
			};
			const rejectedConfig = structuredClone(wallpaperConfig);
			rejectedConfig.background.source = {
				type: "image",
				path: "/tmp/worker-local.jpg",
			};
			const rejectedMemory = await app.request(
				`/editor/sessions/${sessionId}/config/memory`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify(rejectedConfig),
				},
			);
			expect(rejectedMemory.status).toBe(502);
			const rejectedSave = await app.request(
				`/editor/sessions/${sessionId}/config`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify(rejectedConfig),
				},
			);
			expect(rejectedSave.status).toBe(502);
			expect(await Bun.file(configPath).text()).toBe(diskBefore);
			const wallpaperMemory = await app.request(
				`/editor/sessions/${sessionId}/config/memory`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify(wallpaperConfig),
				},
			);
			expect(wallpaperMemory.status).toBe(204);
			const wallpaperView = await app.request(
				`/editor/sessions/${sessionId}/config`,
				{ headers },
			);
			expect(
				((await wallpaperView.json()) as typeof wallpaperConfig).background
					.source.path,
			).toBe(wallpaperId);
			const nativeWallpaper =
				await getEditorSession(sessionId)?.request("/config");
			expect(nativeWallpaper?.status).toBe(200);
			expect(
				((await nativeWallpaper?.json()) as typeof wallpaperConfig).background
					.source.path,
			).toBe(join(editorWallpaperDirectory(), "macOS/tahoe-dusk-min.jpg"));
			const wallpaperPreview = await app.request(
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
			expect(wallpaperPreview.status).toBe(200);
			expect((await wallpaperPreview.arrayBuffer()).byteLength).toBeGreaterThan(
				600_000,
			);
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
			const bundlePath = `/editor/sessions/${sessionId}/project-bundle`;
			const unauthorizedBundle = await app.request(
				`${bundlePath}/download-ticket`,
				{ method: "POST", body: "{}" },
			);
			expect(unauthorizedBundle.status).toBe(401);
			const bundleTicket = await app.request(`${bundlePath}/download-ticket`, {
				method: "POST",
				headers,
				body: JSON.stringify({ fileName: "Paired test.capbundle" }),
			});
			expect(bundleTicket.status).toBe(200);
			const bundleUrl = new URL(
				((await bundleTicket.json()) as { url: string }).url,
			);
			expect(bundleUrl.pathname).toBe(`${bundlePath}/download`);
			const downloadedBundle = await app.request(
				`${bundleUrl.pathname}${bundleUrl.search}`,
			);
			expect(downloadedBundle.status).toBe(200);
			expect(downloadedBundle.headers.get("Content-Disposition")).toContain(
				"Paired test.capbundle",
			);
			const bundleBytes = new Uint8Array(await downloadedBundle.arrayBuffer());
			const manifestLength = readCapBundleManifestLength(
				bundleBytes.subarray(0, CAP_BUNDLE_HEADER_BYTES),
			);
			expect(manifestLength).not.toBeNull();
			if (manifestLength === null)
				throw new Error("Invalid editor bundle header");
			const bundleManifest = parseCapBundleManifest(
				bundleBytes.subarray(
					CAP_BUNDLE_HEADER_BYTES,
					CAP_BUNDLE_HEADER_BYTES + manifestLength,
				),
				bundleBytes.byteLength,
			);
			expect(bundleManifest?.files.map((file) => file.path)).toContain(
				"content/segments/segment-0/display.webm",
			);
			expect(bundleManifest?.files.map((file) => file.path)).toContain(
				"content/segments/segment-0/camera.webm",
			);
			expect(
				(await app.request(`${bundleUrl.pathname}${bundleUrl.search}`)).status,
			).toBe(404);
			const ticketResponse = await app.request(
				`/editor/sessions/${sessionId}/sockets`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ origin: "http://127.0.0.1:3000" }),
				},
			);
			expect(ticketResponse.status).toBe(200);
			const ticketData = (await ticketResponse.json()) as {
				videoId: string;
				sockets: {
					frames: { url: string; ticket: string };
					commands: { url: string; ticket: string };
				};
			};
			expect(ticketData.videoId).toBe("test-paired");
			const frameSocket = ticketData.sockets.frames;
			const BunWebSocket = WebSocket as unknown as new (
				url: string,
				options: Bun.WebSocketOptions,
			) => WebSocket;
			socket = new BunWebSocket(frameSocket.url, {
				protocols: ["cap-editor-v1", `cap-editor-ticket.${frameSocket.ticket}`],
				headers: { Origin: "http://127.0.0.1:3000" },
			});
			socket.binaryType = "arraybuffer";
			const frame = await new Promise<ArrayBuffer>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Editor frame socket timed out")),
					5000,
				);
				if (!socket) return reject(new Error("Missing editor frame socket"));
				socket.onmessage = (event: MessageEvent<unknown>) => {
					clearTimeout(timer);
					if (event.data instanceof ArrayBuffer) resolve(event.data);
					else reject(new Error("Editor frame was not binary"));
				};
				socket.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Editor frame socket failed"));
				};
			});
			expect(frame.byteLength).toBeGreaterThan(20_000);
			expect(frame.byteLength).toBeLessThan(600_000);
			const compressedFrame = new Uint8Array(frame);
			expect(new TextDecoder().decode(compressedFrame.subarray(0, 8))).toBe(
				"CAPPNG01",
			);
			expect(compressedFrame.subarray(8, 16)).toEqual(
				new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
			);
			expect(socket.protocol).toBe("cap-editor-v1");
			const commandTicket = ticketData.sockets.commands;
			commandSocket = new BunWebSocket(commandTicket.url, {
				protocols: [
					"cap-editor-v1",
					`cap-editor-ticket.${commandTicket.ticket}`,
				],
				headers: { Origin: "http://127.0.0.1:3000" },
			});
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error("Editor command socket timed out")),
					5000,
				);
				if (!commandSocket)
					return reject(new Error("Missing editor command socket"));
				commandSocket.onopen = () => {
					clearTimeout(timer);
					resolve();
				};
				commandSocket.onerror = () => {
					clearTimeout(timer);
					reject(new Error("Editor command socket failed"));
				};
			});
			if (!commandSocket) throw new Error("Missing editor command socket");
			const attachedFuture = Date.now() + 5 * 60 * 1000;
			const attachedClock = spyOn(Date, "now").mockReturnValue(attachedFuture);
			try {
				expect(getEditorSession(sessionId)).not.toBeNull();
			} finally {
				attachedClock.mockRestore();
			}
			const currentCommandSocket = commandSocket;
			type CommandReply = {
				kind: string;
				id: number;
				value?: unknown;
				error?: string;
			};
			const pendingReplies = new Map<
				number,
				{
					resolve: (reply: CommandReply) => void;
					reject: (error: Error) => void;
					timer: ReturnType<typeof setTimeout>;
				}
			>();
			const estimateUpdates: unknown[] = [];
			currentCommandSocket.onmessage = (event: MessageEvent<unknown>) => {
				if (typeof event.data !== "string") return;
				const reply = JSON.parse(event.data) as CommandReply;
				if (reply.kind === "channel" && reply.id === 55) {
					estimateUpdates.push(reply.value);
					return;
				}
				const pending = pendingReplies.get(reply.id);
				if (!pending) return;
				pendingReplies.delete(reply.id);
				clearTimeout(pending.timer);
				pending.resolve(reply);
			};
			const sendCommand = (id: number, name: string, args: unknown[]) =>
				new Promise<CommandReply>((resolve, reject) => {
					const timer = setTimeout(() => {
						pendingReplies.delete(id);
						reject(new Error("Editor command reply timed out"));
					}, 5000);
					pendingReplies.set(id, { resolve, reject, timer });
					currentCommandSocket.send(
						JSON.stringify({ kind: "invoke", id, name, args }),
					);
				});
			const browserInstance = await sendCommand(1, "createEditorInstance", []);
			expect(browserInstance.kind).toBe("result");
			expect(browserInstance.value).toMatchObject({
				path: `cap-web-editor://session/${sessionId}`,
				framesSocketUrl: "",
				savedProjectConfig: {
					background: { source: { path: wallpaperId } },
				},
			});
			const musicCatalog = await sendCommand(14, "listAudioLibrary", []);
			expect(musicCatalog.kind).toBe("result");
			expect(musicCatalog.value).toHaveLength(10);
			expect((musicCatalog.value as Array<{ name: string }>)[0]?.name).toBe(
				"Lofi Beats",
			);
			const randomGradient = await sendCommand(
				16,
				"randomAnimatedGradient",
				[],
			);
			expect(randomGradient.kind).toBe("result");
			expect(randomGradient.value).toMatchObject({
				colorStops: expect.any(Array),
				seed: expect.any(Number),
				motionSpeed: expect.any(Number),
			});
			const clipThumbnail = await sendCommand(17, "getClipThumbnail", [0, 1.5]);
			expect(clipThumbnail.kind).toBe("result");
			expect(clipThumbnail.value).toMatch(/^data:image\/jpeg;base64,/);
			const thumbnailBytes = Buffer.from(
				(clipThumbnail.value as string).slice("data:image/jpeg;base64,".length),
				"base64",
			);
			expect(thumbnailBytes.length).toBeGreaterThan(1000);
			const thumbnailPath = join(root, "clip-thumbnail.jpg");
			await writeFile(thumbnailPath, thumbnailBytes);
			const thumbnailProbe = spawnSync("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"stream=width,height",
				"-of",
				"json",
				thumbnailPath,
			]);
			expect(thumbnailProbe.status).toBe(0);
			expect(JSON.parse(thumbnailProbe.stdout.toString())).toMatchObject({
				streams: [{ width: 240, height: 135 }],
			});
			const invalidThumbnail = await sendCommand(
				18,
				"getClipThumbnail",
				[-1, 1.5],
			);
			expect(invalidThumbnail.kind).toBe("error");
			expect(invalidThumbnail.error).toBe("Invalid clip thumbnail request");
			const musicTrack = await sendCommand(15, "addAudioLibraryTrack", [
				"lofi-beats-mirostar",
			]);
			expect(musicTrack.kind).toBe("result");
			expect(musicTrack.value).toMatchObject({
				path: "assets/audio/library-lofi-beats-mirostar.mp3",
				name: "Lofi Beats",
			});
			expect(
				(musicTrack.value as { duration: number }).duration,
			).toBeGreaterThan(30);
			const importedAudioAsset = {
				path: `assets/audio/import-${randomUUID()}.mp3`,
				name: "Imported tone",
				url: `http://127.0.0.1:${server.port}/imported.mp3`,
				size: (await stat(importedAudioPath)).size,
				contentType: "audio/mpeg",
				objectIdentity: null,
			};
			const audioImport = await app.request(
				`/editor/sessions/${sessionId}/audio-assets`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(importedAudioAsset),
				},
			);
			expect(audioImport.status).toBe(200);
			const importedTrack = (await audioImport.json()) as {
				path: string;
				name: string;
				duration: number;
			};
			expect(importedTrack.path).toBe(importedAudioAsset.path);
			expect(importedTrack.duration).toBeGreaterThan(2.9);
			expect((await stat(join(data.path, importedTrack.path))).size).toBe(
				importedAudioAsset.size,
			);
			const importedImageAsset = {
				path: `content/images/${randomUUID()}.png`,
				name: "Overlay",
				url: `http://127.0.0.1:${server.port}/overlay.png`,
				size: (await stat(importedImagePath)).size,
				contentType: "image/png",
				objectIdentity: null,
			};
			const imageImport = await app.request(
				`/editor/sessions/${sessionId}/image-assets`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(importedImageAsset),
				},
			);
			expect(imageImport.status).toBe(200);
			const importedImage = (await imageImport.json()) as {
				path: string;
				name: string;
				width: number;
				height: number;
			};
			expect(importedImage).toEqual({
				path: importedImageAsset.path,
				name: "Overlay",
				width: 120,
				height: 80,
			});
			const importedVideoAsset = {
				path: `content/videos/${randomUUID()}.mp4`,
				name: "Green overlay",
				url: `http://127.0.0.1:${server.port}/overlay.mp4`,
				size: (await stat(importedVideoPath)).size,
				contentType: "video/mp4",
				objectIdentity: null,
			};
			const videoImport = await app.request(
				`/editor/sessions/${sessionId}/video-assets`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(importedVideoAsset),
				},
			);
			expect(videoImport.status).toBe(202);
			const videoJobId = ((await videoImport.json()) as { id: string }).id;
			type ImportedVideoFixture = {
				path: string;
				name: string;
				duration: number;
				fps: number;
				width: number;
				height: number;
				hasAudio: boolean;
			};
			let importedVideo: ImportedVideoFixture | null = null;
			const videoImportDeadline = Date.now() + 10_000;
			while (Date.now() < videoImportDeadline) {
				const response = await app.request(
					`/editor/sessions/${sessionId}/video-assets/${videoJobId}`,
					{ headers },
				);
				expect(response.status).toBe(200);
				const status = (await response.json()) as {
					status: string;
					result: ImportedVideoFixture | null;
					error: string | null;
				};
				if (status.status === "ready") {
					importedVideo = status.result;
					break;
				}
				if (status.status === "error")
					throw new Error(status.error ?? "Video import failed");
				await Bun.sleep(50);
			}
			if (!importedVideo) throw new Error("Imported video did not stage");
			expect(importedVideo).toMatchObject({
				path: importedVideoAsset.path,
				name: "Green overlay",
				fps: 30,
				width: 320,
				height: 180,
				hasAudio: true,
			});
			expect(importedVideo.duration).toBeGreaterThan(2.9);
			expect((await stat(join(data.path, importedVideo.path))).size).toBe(
				importedVideoAsset.size,
			);
			const imageBackgroundConfig = structuredClone(data.savedProjectConfig);
			imageBackgroundConfig.background.source = {
				type: "image",
				path: importedImage.path,
			};
			const imageBackgroundUpdate = await app.request(
				`/editor/sessions/${sessionId}/config/memory`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify(imageBackgroundConfig),
				},
			);
			expect(imageBackgroundUpdate.status).toBe(204);
			const nativeImageBackground =
				await getEditorSession(sessionId)?.request("/config");
			expect(
				((await nativeImageBackground?.json()) as typeof imageBackgroundConfig)
					.background.source.path,
			).toBe(join(data.path, importedImage.path));
			const browserImageBackground = await app.request(
				`/editor/sessions/${sessionId}/config`,
				{ headers },
			);
			expect(
				((await browserImageBackground.json()) as typeof imageBackgroundConfig)
					.background.source.path,
			).toBe(importedImage.path);
			const imageBackgroundPreview = await app.request(
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
			expect(imageBackgroundPreview.status).toBe(200);
			expect(
				(await imageBackgroundPreview.arrayBuffer()).byteLength,
			).toBeGreaterThan(600_000);
			const restoreWallpaper = await app.request(
				`/editor/sessions/${sessionId}/config/memory`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify(wallpaperConfig),
				},
			);
			expect(restoreWallpaper.status).toBe(204);
			expect(
				(await sendCommand(16, "addAudioLibraryTrack", ["../foreign"])).kind,
			).toBe("error");
			const exportPreview = await sendCommand(9, "generateExportPreviewFast", [
				1.5,
				{
					fps: 30,
					resolution_base: { x: 640, y: 360 },
					compression_bpp: 0.15,
					cursor_only: false,
				},
			]);
			expect(exportPreview.kind).toBe("result");
			const previewResult = exportPreview.value as {
				jpeg_base64: string;
				actual_width: number;
				actual_height: number;
				estimated_size_mb: number;
				total_frames: number;
			};
			expect(previewResult.jpeg_base64.startsWith("/9j/")).toBe(true);
			expect(previewResult.actual_width).toBe(640);
			expect(previewResult.actual_height).toBeGreaterThanOrEqual(350);
			expect(previewResult.estimated_size_mb).toBeGreaterThan(0);
			expect(previewResult.total_frames).toBeGreaterThan(80);
			const estimateSettings = {
				format: "Mp4",
				fps: 30,
				resolution_base: { x: 640, y: 360 },
				compression: "Web",
				custom_bpp: null,
			};
			const estimate = await sendCommand(10, "getExportEstimates", [
				`cap-web-editor://session/${sessionId}`,
				estimateSettings,
				"__CHANNEL__:55",
			]);
			expect(estimate.kind).toBe("result");
			const estimateResult = estimate.value as {
				duration_seconds: number;
				estimated_time_seconds: number;
				estimated_size_mb: number;
			};
			expect(estimateResult.duration_seconds).toBeGreaterThan(2);
			expect(estimateResult.estimated_time_seconds).toBeGreaterThan(0);
			expect(estimateResult.estimated_size_mb).toBeGreaterThan(0);
			const repeatedEstimate = await sendCommand(11, "getExportEstimates", [
				`cap-web-editor://session/${sessionId}`,
				estimateSettings,
				"__CHANNEL__:55",
			]);
			expect(repeatedEstimate.kind).toBe("result");
			expect(estimateUpdates.length).toBeGreaterThan(0);
			expect(estimateUpdates.at(-1)).toEqual(estimateResult);
			expect(await sendCommand(12, "cancelExportEstimates", [])).toMatchObject({
				kind: "result",
				value: null,
			});
			expect(
				(
					await sendCommand(13, "getExportEstimates", [
						"cap-web-editor://session/foreign",
						estimateSettings,
						"__CHANNEL__:55",
					])
				).kind,
			).toBe("error");
			const systemWaveforms = await sendCommand(
				5,
				"getSystemAudioWaveforms",
				[],
			);
			expect(systemWaveforms.kind).toBe("result");
			const systemPeaks = systemWaveforms.value as number[][];
			expect(systemPeaks).toHaveLength(1);
			expect(systemPeaks[0]?.length).toBeGreaterThan(20);
			expect(systemPeaks[0]?.some((peak) => peak > -60)).toBe(true);
			const micWaveforms = await sendCommand(6, "getMicWaveforms", []);
			expect(micWaveforms).toMatchObject({ kind: "result", value: [[]] });
			const native = getEditorSession(readySessionId);
			if (!native) throw new Error("Missing native editor session");
			const originalRequest = native.request;
			native.request = (path, init) =>
				path === "/waveforms/system"
					? (async () => {
							await Bun.sleep(1500);
							return originalRequest(path, init);
						})()
					: originalRequest(path, init);
			try {
				const slowStarted = performance.now();
				const slowWaveform = sendCommand(7, "getSystemAudioWaveforms", []);
				await Bun.sleep(20);
				const seekStarted = performance.now();
				const seek = await sendCommand(8, "seekTo", [30]);
				expect(seek.kind).toBe("result");
				expect(performance.now() - seekStarted).toBeLessThan(1000);
				expect((await slowWaveform).kind).toBe("result");
				expect(performance.now() - slowStarted).toBeGreaterThan(1400);
			} finally {
				native.request = originalRequest;
			}
			const changedConfig = structuredClone(data.savedProjectConfig);
			changedConfig.camera.mirror = !changedConfig.camera.mirror;
			changedConfig.background.source = {
				type: "wallpaper",
				path: wallpaperId,
			};
			const selectedMusic = musicTrack.value as {
				path: string;
				name: string;
				duration: number;
			};
			changedConfig.timeline.audioSegments.push({
				start: 0,
				end: 2.5,
				track: 0,
				path: selectedMusic.path,
				name: selectedMusic.name,
				enabled: true,
				trimStart: 0,
				volumeDb: 0,
				fadeIn: 0,
				fadeOut: 0,
				duration: selectedMusic.duration,
			});
			changedConfig.timeline.audioSegments.push({
				start: 0,
				end: 2.5,
				track: 1,
				path: importedTrack.path,
				name: importedTrack.name,
				enabled: true,
				trimStart: 0,
				volumeDb: 0,
				fadeIn: 0,
				fadeOut: 0,
				duration: importedTrack.duration,
			});
			changedConfig.timeline.imageSegments ??= [];
			changedConfig.timeline.imageSegments.push({
				start: 0,
				end: 3,
				track: 0,
				path: importedImage.path,
				name: importedImage.name,
				enabled: true,
				center: { x: 0.5, y: 0.5 },
				size: { x: 0.5, y: 0.5 },
				opacity: 1,
				rotation: 0,
				flipX: false,
				flipY: false,
				lockAspect: true,
			});
			const memoryUpdate = await sendCommand(2, "updateProjectConfigInMemory", [
				changedConfig,
				30,
				30,
				{ x: 640, y: 360 },
			]);
			expect(memoryUpdate.kind).toBe("result");
			const memoryConfig = await app.request(
				`/editor/sessions/${sessionId}/config`,
				{ headers },
			);
			const configuredImage = (await memoryConfig.json()) as {
				background: { source: { path: string } };
				timeline: { imageSegments: Array<{ path: string }> };
			};
			expect(configuredImage.background.source.path).toBe(wallpaperId);
			expect(configuredImage.timeline.imageSegments[0]?.path).toBe(
				importedImage.path,
			);
			const centerMagentaScore = (bytes: Buffer) => {
				const stride = bytes.readUInt32LE(bytes.length - 24);
				const offset = 180 * stride + 320 * 4;
				return bytes[offset] + bytes[offset + 2] - 2 * bytes[offset + 1];
			};
			let imageScore = 0;
			for (let attempt = 0; attempt < 10; attempt++) {
				const imagePreview = await app.request(
					`/editor/sessions/${sessionId}/preview`,
					{
						method: "POST",
						headers,
						body: JSON.stringify({
							frameNumber: 31 + attempt,
							fps: 30,
							resolutionBase: { x: 640, y: 360 },
						}),
					},
				);
				expect(imagePreview.status).toBe(200);
				imageScore = centerMagentaScore(
					Buffer.from(await imagePreview.arrayBuffer()),
				);
				if (imageScore > 400) break;
				await Bun.sleep(50);
			}
			expect(imageScore).toBeGreaterThan(400);
			expect(await Bun.file(configPath).text()).toBe(diskBefore);
			const stockConfig = await sendCommand(3, "getDefaultProjectConfig", []);
			expect(stockConfig.value).toMatchObject({
				background: { padding: 10, rounding: 7.5 },
				camera: { mirror: data.savedProjectConfig.camera.mirror },
			});
			const liveConfig = await app.request(
				`/editor/sessions/${sessionId}/config`,
				{ headers },
			);
			expect(liveConfig.status).toBe(200);
			expect(await liveConfig.json()).toMatchObject({
				camera: { mirror: changedConfig.camera.mirror },
			});
			const deniedSave = await sendCommand(4, "setProjectConfig", [
				changedConfig,
			]);
			expect(deniedSave.kind).toBe("error");
			const saved = await app.request(`/editor/sessions/${sessionId}/config`, {
				method: "PUT",
				headers,
				body: JSON.stringify(changedConfig),
			});
			expect(saved.status).toBe(204);
			expect(await Bun.file(configPath).text()).not.toBe(diskBefore);
			const invalidExport = await app.request(
				`/editor/sessions/${sessionId}/exports`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ format: "Mp4", fps: 0 }),
				},
			);
			expect(invalidExport.status).toBe(400);
			const mp4Settings = {
				format: "Mp4",
				fps: 30,
				resolution_base: { x: 640, y: 360 },
				compression: "Social",
				custom_bpp: null,
				force_ffmpeg_decoder: true,
				optimize_filesize: false,
			};
			const startedExport = await app.request(
				`/editor/sessions/${sessionId}/exports`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(mp4Settings),
				},
			);
			expect(startedExport.status).toBe(202);
			const exportId = ((await startedExport.json()) as { id: string }).id;
			const duplicateExport = await app.request(
				`/editor/sessions/${sessionId}/exports`,
				{
					method: "POST",
					headers,
					body: JSON.stringify(mp4Settings),
				},
			);
			expect(duplicateExport.status).toBe(503);
			const waitForExport = async (id: string) => {
				const deadline = Date.now() + 10_000;
				while (Date.now() < deadline) {
					const pending = await app.request(
						`/editor/sessions/${sessionId}/exports/${id}`,
						{ headers },
					);
					const state = (await pending.json()) as {
						status: string;
						progress: { rendered_count: number; total_frames: number } | null;
						error: string | null;
						size: number | null;
						mediaMetadata: {
							duration: number;
							width: number;
							height: number;
							fps: number;
						} | null;
					};
					if (state.status === "ready") return state;
					if (state.status === "error")
						throw new Error(state.error || "Native editor export failed");
					await Bun.sleep(50);
				}
				throw new Error("Native editor export timed out");
			};
			const exportedMp4 = await waitForExport(exportId);
			expect(exportedMp4.progress?.rendered_count).toBeGreaterThan(80);
			expect(exportedMp4.progress?.total_frames).toBeGreaterThan(80);
			expect(exportedMp4.size).toBeGreaterThan(40_000);
			expect(exportedMp4.mediaMetadata?.width).toBe(640);
			expect(exportedMp4.mediaMetadata?.height).toBeGreaterThanOrEqual(350);
			expect(exportedMp4.mediaMetadata?.height).toBeLessThanOrEqual(360);
			expect(exportedMp4.mediaMetadata?.duration).toBeGreaterThan(2);
			const mp4File = await app.request(
				`/editor/sessions/${sessionId}/exports/${exportId}/file`,
				{ headers },
			);
			expect(mp4File.status).toBe(200);
			expect(mp4File.headers.get("Content-Type")).toBe("video/mp4");
			const mp4Bytes = await mp4File.arrayBuffer();
			expect(mp4Bytes.byteLength).toBeGreaterThan(40_000);
			expect(exportedMp4.size).toBe(mp4Bytes.byteLength);
			const exportChunkPath = `/editor/sessions/${sessionId}/exports/${exportId}/chunk`;
			for (const [offset, length] of [
				[0, 16 * 1024],
				[mp4Bytes.byteLength - 16 * 1024, 16 * 1024],
			]) {
				const chunk = await app.request(
					`${exportChunkPath}?offset=${offset}&length=${length}`,
					{ headers },
				);
				expect(chunk.status).toBe(206);
				expect(chunk.headers.get("Content-Range")).toBe(
					`bytes ${offset}-${offset + length - 1}/${mp4Bytes.byteLength}`,
				);
				expect(Buffer.from(await chunk.arrayBuffer())).toEqual(
					Buffer.from(mp4Bytes.slice(offset, offset + length)),
				);
			}
			const invalidChunk = await app.request(
				`${exportChunkPath}?offset=0&length=${16 * 1024 * 1024 + 1}`,
				{ headers },
			);
			expect(invalidChunk.status).toBe(400);
			const downloadedMp4 = join(root, "downloaded-export.mp4");
			await writeFile(downloadedMp4, Buffer.from(mp4Bytes));
			const mp4Probe = spawnSync("ffprobe", [
				"-v",
				"error",
				"-show_entries",
				"stream=codec_name,codec_type,width,height,nb_frames",
				"-of",
				"json",
				downloadedMp4,
			]);
			expect(mp4Probe.status).toBe(0);
			const mp4Streams = JSON.parse(mp4Probe.stdout.toString()) as {
				streams: Array<{
					codec_name: string;
					codec_type: string;
					width?: number;
					height?: number;
					nb_frames?: string;
				}>;
			};
			const videoStream = mp4Streams.streams.find(
				(stream) => stream.codec_type === "video",
			);
			expect(videoStream?.codec_name).toBe("h264");
			expect(videoStream?.width).toBe(640);
			expect(exportedMp4.mediaMetadata?.height).toBe(videoStream?.height);
			expect(videoStream?.height).toBeGreaterThanOrEqual(350);
			expect(videoStream?.height).toBeLessThanOrEqual(360);
			expect(
				mp4Streams.streams.some((stream) => stream.codec_type === "audio"),
			).toBe(true);
			const filteredAudio = spawnSync(
				"ffmpeg",
				[
					"-v",
					"error",
					"-i",
					downloadedMp4,
					"-af",
					"highpass=f=1000",
					"-f",
					"s16le",
					"-ac",
					"1",
					"-ar",
					"16000",
					"-",
				],
				{ maxBuffer: 1024 * 1024 },
			);
			expect(filteredAudio.status).toBe(0);
			const rms = (from: number, to: number) => {
				let total = 0;
				const start = Math.floor(from * 16000);
				const end = Math.min(
					Math.floor(to * 16000),
					filteredAudio.stdout.length / 2,
				);
				for (let sample = start; sample < end; sample++) {
					const value = filteredAudio.stdout.readInt16LE(sample * 2);
					total += value * value;
				}
				return Math.sqrt(total / (end - start));
			};
			expect(rms(0.5, 1.5)).toBeGreaterThan(rms(2.7, 2.95) * 1.5);
			const toneLevel = (from: number, to: number) => {
				const start = Math.floor(from * 16000);
				const end = Math.min(
					Math.floor(to * 16000),
					filteredAudio.stdout.length / 2,
				);
				let cosine = 0;
				let sine = 0;
				for (let sample = start; sample < end; sample++) {
					const value = filteredAudio.stdout.readInt16LE(sample * 2);
					const phase = (2 * Math.PI * 1200 * sample) / 16000;
					cosine += value * Math.cos(phase);
					sine += value * Math.sin(phase);
				}
				return Math.hypot(cosine, sine) / (end - start);
			};
			expect(toneLevel(0.5, 1.5)).toBeGreaterThan(toneLevel(2.7, 2.95) * 10);
			const removedMp4 = await app.request(
				`/editor/sessions/${sessionId}/exports/${exportId}`,
				{ method: "DELETE", headers },
			);
			expect(removedMp4.status).toBe(204);
			expect(
				(
					await app.request(
						`/editor/sessions/${sessionId}/exports/${exportId}/file`,
						{ headers },
					)
				).status,
			).toBe(404);
			const gifStart = await app.request(
				`/editor/sessions/${sessionId}/exports`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						format: "Gif",
						fps: 10,
						resolution_base: { x: 320, y: 180 },
						quality: { quality: 80, fast: true },
					}),
				},
			);
			expect(gifStart.status).toBe(202);
			const gifId = ((await gifStart.json()) as { id: string }).id;
			const exportedGif = await waitForExport(gifId);
			expect(exportedGif.progress?.total_frames).toBeGreaterThan(20);
			const gifFile = await app.request(
				`/editor/sessions/${sessionId}/exports/${gifId}/file`,
				{ headers },
			);
			expect(gifFile.status).toBe(200);
			expect(gifFile.headers.get("Content-Type")).toBe("image/gif");
			const gifBytes = await gifFile.arrayBuffer();
			expect(Buffer.from(gifBytes).toString("ascii", 0, 4)).toBe("GIF8");
			const downloadTicketResponse = await app.request(
				`/editor/sessions/${sessionId}/exports/${gifId}/download-ticket`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ fileName: "Paired test.gif" }),
				},
			);
			expect(downloadTicketResponse.status).toBe(200);
			const downloadTicket = (await downloadTicketResponse.json()) as {
				url: string;
			};
			const downloadUrl = new URL(downloadTicket.url);
			expect(
				(await app.request(`${downloadUrl.pathname}?ticket=wrong-token`))
					.status,
			).toBe(404);
			const directDownload = await app.request(
				`${downloadUrl.pathname}${downloadUrl.search}`,
			);
			expect(directDownload.status).toBe(200);
			expect(directDownload.headers.get("Content-Type")).toBe("image/gif");
			expect(directDownload.headers.get("Content-Disposition")).toContain(
				`filename="Paired test.gif"`,
			);
			expect(directDownload.headers.get("Content-Length")).toBe(
				String(gifBytes.byteLength),
			);
			expect(Buffer.from(await directDownload.arrayBuffer())).toEqual(
				Buffer.from(gifBytes),
			);
			expect(
				(await app.request(`${downloadUrl.pathname}${downloadUrl.search}`))
					.status,
			).toBe(404);
			expect(
				(
					await app.request(
						`/editor/sessions/${sessionId}/exports/${gifId}/file`,
						{ headers },
					)
				).status,
			).toBe(404);
			const closeExportStart = await app.request(
				`/editor/sessions/${sessionId}/exports`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({
						format: "Gif",
						fps: 10,
						resolution_base: { x: 320, y: 180 },
						quality: { quality: 80, fast: true },
					}),
				},
			);
			expect(closeExportStart.status).toBe(202);
			const closeExportId = ((await closeExportStart.json()) as { id: string })
				.id;
			await waitForExport(closeExportId);
			const closeExportFile = await app.request(
				`/editor/sessions/${sessionId}/exports/${closeExportId}/file`,
				{ headers },
			);
			expect(closeExportFile.status).toBe(200);
			const closeExportBytes = Buffer.from(await closeExportFile.arrayBuffer());
			const closeDownloadTicket = await app.request(
				`/editor/sessions/${sessionId}/exports/${closeExportId}/download-ticket`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ fileName: "After page close.gif" }),
				},
			);
			expect(closeDownloadTicket.status).toBe(200);
			const closeDownloadUrl = new URL(
				((await closeDownloadTicket.json()) as { url: string }).url,
			);
			commandSocket.close();
			commandSocket = null;
			socket.close();
			socket = null;
			const expectSocketRejected = async (
				credential: { url: string; ticket: string },
				origin: string,
			) => {
				const attempt = new BunWebSocket(credential.url, {
					protocols: [
						"cap-editor-v1",
						`cap-editor-ticket.${credential.ticket}`,
					],
					headers: { Origin: origin },
				});
				try {
					await new Promise<void>((resolve, reject) => {
						const timer = setTimeout(
							() => reject(new Error("Unauthorized socket did not terminate")),
							3000,
						);
						attempt.onopen = () => {
							clearTimeout(timer);
							reject(new Error("Unauthorized editor socket opened"));
						};
						attempt.onerror = () => {
							clearTimeout(timer);
							resolve();
						};
						attempt.onclose = () => {
							clearTimeout(timer);
							resolve();
						};
					});
				} finally {
					attempt.close();
				}
			};
			await expectSocketRejected(frameSocket, "http://127.0.0.1:3000");
			const wrongOriginTicketResponse = await app.request(
				`/editor/sessions/${sessionId}/sockets`,
				{
					method: "POST",
					headers,
					body: JSON.stringify({ origin: "http://127.0.0.1:3000" }),
				},
			);
			expect(wrongOriginTicketResponse.status).toBe(200);
			const wrongOriginTickets = (await wrongOriginTicketResponse.json()) as {
				sockets: { commands: { url: string; ticket: string } };
			};
			await expectSocketRejected(
				wrongOriginTickets.sockets.commands,
				"http://127.0.0.1:3001",
			);
			await expectSocketRejected(
				wrongOriginTickets.sockets.commands,
				"http://127.0.0.1:3000",
			);
			const closed = await app.request(`/editor/sessions/${sessionId}`, {
				method: "DELETE",
				headers,
			});
			expect(closed.status).toBe(204);
			sessionId = null;
			const downloadAfterClose = await app.request(
				`${closeDownloadUrl.pathname}${closeDownloadUrl.search}`,
			);
			expect(downloadAfterClose.status).toBe(200);
			expect(downloadAfterClose.headers.get("Content-Disposition")).toContain(
				`filename="After page close.gif"`,
			);
			expect(Buffer.from(await downloadAfterClose.arrayBuffer())).toEqual(
				closeExportBytes,
			);
			expect(
				(
					await app.request(
						`${closeDownloadUrl.pathname}${closeDownloadUrl.search}`,
					)
				).status,
			).toBe(404);
			const reopen = await app.request("/editor/preparations", {
				method: "POST",
				headers,
				body: JSON.stringify({
					...sources,
					projectConfig: changedConfig,
					audioAssets: [importedAudioAsset],
					imageAssets: [importedImageAsset],
					videoAssets: [importedVideoAsset],
				}),
			});
			expect(reopen.status).toBe(202);
			const reopenedPreparation = (await reopen.json()) as { id: string };
			const reopenDeadline = Date.now() + 10_000;
			while (Date.now() < reopenDeadline) {
				const pending = await app.request(
					`/editor/preparations/${reopenedPreparation.id}`,
					{ headers },
				);
				const state = (await pending.json()) as {
					status: string;
					sessionId?: string;
				};
				if (state.status === "ready") {
					sessionId = state.sessionId ?? null;
					break;
				}
				if (state.status === "error")
					throw new Error("Saved editor project could not reopen");
				await Bun.sleep(50);
			}
			expect(sessionId).not.toBeNull();
			if (!sessionId) throw new Error("Saved editor project did not reopen");
			const reopenedInstance = await app.request(
				`/editor/sessions/${sessionId}/instance`,
				{ headers },
			);
			expect(reopenedInstance.status).toBe(200);
			const restored = (await reopenedInstance.json()) as {
				savedProjectConfig: {
					camera: { mirror: boolean };
					background: { source: { path: string } };
					timeline: {
						audioSegments: Array<{ path: string }>;
						imageSegments: Array<{ path: string }>;
					};
				};
			};
			expect(restored.savedProjectConfig.camera.mirror).toBe(
				changedConfig.camera.mirror,
			);
			expect(restored.savedProjectConfig.background.source.path).toBe(
				wallpaperId,
			);
			expect(restored.savedProjectConfig.timeline.audioSegments[0]?.path).toBe(
				selectedMusic.path,
			);
			expect(restored.savedProjectConfig.timeline.audioSegments[1]?.path).toBe(
				importedTrack.path,
			);
			expect(restored.savedProjectConfig.timeline.imageSegments[0]?.path).toBe(
				importedImage.path,
			);
			const reopenedProjectPath = getEditorSession(sessionId)?.projectPath;
			if (!reopenedProjectPath)
				throw new Error("Missing reopened editor project");
			expect(
				(await stat(join(reopenedProjectPath, selectedMusic.path))).size,
			).toBeGreaterThan(100_000);
			expect(
				(await stat(join(reopenedProjectPath, importedTrack.path))).size,
			).toBe(importedAudioAsset.size);
			expect(
				(await stat(join(reopenedProjectPath, importedImage.path))).size,
			).toBe(importedImageAsset.size);
			expect(
				(await stat(join(reopenedProjectPath, importedVideo.path))).size,
			).toBe(importedVideoAsset.size);
			const unclaimedSessionId = sessionId;
			const expiredFuture = Date.now() + 5 * 60 * 1000;
			const expiredClock = spyOn(Date, "now").mockReturnValue(expiredFuture);
			let screenOnly: Response | null = null;
			try {
				screenOnly = await app.request("/editor/preparations", {
					method: "POST",
					headers,
					body: JSON.stringify({
						videoId: "test-screen-only",
						title: "Screen only",
						display: sources.display,
					}),
				});
			} finally {
				expiredClock.mockRestore();
			}
			if (!screenOnly) throw new Error("Screen-only editor preparation failed");
			expect(screenOnly.status).toBe(202);
			expect(getEditorSession(unclaimedSessionId)).toBeNull();
			const expiredPreparation = await app.request(
				`/editor/preparations/${reopenedPreparation.id}`,
				{ headers },
			);
			expect(
				((await expiredPreparation.json()) as { status: string }).status,
			).toBe("closed");
			sessionId = null;
			const screenPreparation = (await screenOnly.json()) as { id: string };
			const screenDeadline = Date.now() + 10_000;
			while (Date.now() < screenDeadline) {
				const pending = await app.request(
					`/editor/preparations/${screenPreparation.id}`,
					{ headers },
				);
				const state = (await pending.json()) as {
					status: string;
					sessionId?: string;
				};
				if (state.status === "ready") {
					sessionId = state.sessionId ?? null;
					break;
				}
				if (state.status === "error")
					throw new Error("Screen-only editor project could not prepare");
				await Bun.sleep(50);
			}
			expect(sessionId).not.toBeNull();
			if (!sessionId)
				throw new Error("Screen-only editor project has no session");
			const screenInstance = await app.request(
				`/editor/sessions/${sessionId}/instance`,
				{ headers },
			);
			expect(screenInstance.status).toBe(200);
			const screenPreview = await app.request(
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
			expect(screenPreview.status).toBe(200);
			expect((await screenPreview.arrayBuffer()).byteLength).toBeGreaterThan(
				1_000,
			);
			const screenClose = await app.request(`/editor/sessions/${sessionId}`, {
				method: "DELETE",
				headers,
			});
			expect(screenClose.status).toBe(204);
			sessionId = null;
		} finally {
			commandSocket?.close();
			socket?.close();
			socketServer?.stop(true);
			if (sessionId) {
				await app.request(`/editor/sessions/${sessionId}`, {
					method: "DELETE",
					headers: { "x-media-server-secret": secret },
				});
			}
			server?.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	},
	30_000,
);
