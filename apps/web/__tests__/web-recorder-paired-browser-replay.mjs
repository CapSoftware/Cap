import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, webkit } from "@playwright/test";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "../../..");
const webRoot = resolve(root, "apps/web");
const artifactDirectory = await mkdtemp(
	join(tmpdir(), "cap-web-recorder-replay-"),
);
const artifact = join(artifactDirectory, "harness.js");
const mockSources = new Map([
	[
		"@tanstack/react-query",
		"export function useQueryClient(){return {refetchQueries(){}}}",
	],
	[
		"next/navigation",
		"export function useRouter(){return {push(){},refresh(){}}}",
	],
	["sonner", "export const toast={error(){},warning(){},success(){},info(){}}"],
	[
		"@cap/web-domain",
		"export const Organisation={OrganisationId:{make(value){return value}}}",
	],
	[
		"@/actions/video/trigger-instant-recording-processing",
		"export async function triggerInstantRecordingProcessing(){}",
	],
	[
		"@/actions/video/upload",
		"export async function createVideoAndGetUploadUrl(){throw new Error('Unused upload path')}",
	],
	[
		"@/lib/EffectRuntime",
		"import {Exit} from 'effect';export function useRpcClient(){return {VideoInstantCreate:async()=>Exit.succeed({id:'test-video',shareUrl:'https://capture.test/share',upload:{}}),VideoDelete:async()=>Exit.succeed(null)}}export function useEffectMutation({mutationFn}){return {mutateAsync:mutationFn}}",
	],
	[
		"@/lib/Requests/ThumbnailRequest",
		"export const ThumbnailRequest={queryKey:()=>[]}",
	],
	["@/utils/upload-target", "export async function uploadWithTarget(){}"],
	[
		"../../UploadingContext",
		"export function useUploadingContext(){return {setUploadStatus(){}}}",
	],
	["../sendProgressUpdate", "export async function sendProgressUpdate(){}"],
	[
		"./recording-conversion",
		"export async function canConvertToMp4InBrowser(){return false}export async function captureThumbnail(){return null}export async function convertToMp4(){throw new Error('Unused conversion path')}",
	],
	[
		"./recording-upload",
		"export async function uploadRecording(){throw new Error('Unused buffered upload path')}",
	],
	[
		"./recovered-recording-cache",
		"export async function loadRecoveredRecordingSpools(){return []}export function removeRecoveredRecordingSpoolFromCache(){}",
	],
]);

await build({
	entryPoints: [resolve(webRoot, "__tests__/web-recorder-browser-harness.tsx")],
	outfile: artifact,
	bundle: true,
	format: "iife",
	platform: "browser",
	jsx: "automatic",
	target: "es2022",
	nodePaths: [resolve(webRoot, "node_modules"), resolve(root, "node_modules")],
	plugins: [
		{
			name: "pr-recorder-dependencies",
			setup(plugin) {
				plugin.onResolve({ filter: /^react(\/jsx-runtime)?$/ }, (args) => ({
					path: resolve(
						root,
						"node_modules/react",
						`${args.path === "react" ? "index" : "jsx-runtime"}.js`,
					),
				}));
				plugin.onResolve({ filter: /^react-dom\/client$/ }, () => ({
					path: resolve(root, "node_modules/react-dom/client.js"),
				}));
				plugin.onResolve({ filter: /^@cap\/recorder-core(\/.*)?$/ }, (args) => {
					const subpath = args.path.replace(/^@cap\/recorder-core\/?/, "");
					const basename = subpath || "index";
					return {
						path: resolve(root, "packages/recorder-core/src", `${basename}.ts`),
					};
				});
				plugin.onResolve({ filter: /.*/ }, (args) => {
					if (!args.importer.endsWith("useWebRecorder.ts")) return;
					if (!mockSources.has(args.path)) return;
					return { path: args.path, namespace: "recorder-replay-mock" };
				});
				plugin.onLoad(
					{ filter: /.*/, namespace: "recorder-replay-mock" },
					(args) => ({
						contents: mockSources.get(args.path),
						loader: "js",
						resolveDir: webRoot,
					}),
				);
			},
		},
	],
});

async function replayPairedCapture(
	browser,
	bundle,
	pauseResume,
	engine,
	failCameraSpool = false,
	failCameraCompletion = false,
) {
	const requests = [];
	const parts = [];
	const browserErrors = [];
	const cameraSubpath = `camera-upload.${engine.extension}`;
	const screenSubpath = `raw-upload.${engine.extension}`;
	const context = await browser.newContext();
	try {
		await context.addInitScript(
			(options) => {
				if (options.failCameraSpool) {
					const put = IDBObjectStore.prototype.put;
					IDBObjectStore.prototype.put = function (value, ...rest) {
						if (
							this.name === "chunks" &&
							value?.sessionId?.endsWith("-camera")
						) {
							window.capRecorderCameraSpoolFailures =
								(window.capRecorderCameraSpoolFailures ?? 0) + 1;
							throw new DOMException(
								"Simulated camera Blob store failure",
								"UnknownError",
							);
						}
						return put.call(this, value, ...rest);
					};
				}
				const createCanvasStream = (width, height, color) => {
					const canvas = document.createElement("canvas");
					canvas.width = width;
					canvas.height = height;
					const canvasContext = canvas.getContext("2d");
					if (!canvasContext) throw new Error("Canvas capture is unavailable");
					let frame = 0;
					const paint = () => {
						canvasContext.fillStyle = color;
						canvasContext.fillRect(0, 0, width, height);
						canvasContext.fillStyle = "white";
						canvasContext.font = "24px sans-serif";
						canvasContext.fillText(String(frame++), 20, 40);
					};
					paint();
					setInterval(paint, 33);
					return canvas.captureStream(30);
				};
				let display;
				let camera;
				const mediaDevices = navigator.mediaDevices;
				window.capRecorderMediaDevices = mediaDevices;
				const getDisplayMedia = async () => {
					display ??= createCanvasStream(640, 360, "#203060");
					return display;
				};
				const getUserMedia = async () => {
					camera ??= createCanvasStream(320, 180, "#b02040");
					return camera;
				};
				Object.defineProperty(mediaDevices, "getDisplayMedia", {
					configurable: true,
					value: getDisplayMedia,
				});
				Object.defineProperty(mediaDevices, "getUserMedia", {
					configurable: true,
					value: getUserMedia,
				});
				window.capRecorderPutBodies = [];
				const open = XMLHttpRequest.prototype.open;
				XMLHttpRequest.prototype.open = function (method, url, ...options) {
					this.capRecorderUploadUrl = method === "PUT" ? String(url) : null;
					return open.call(this, method, url, ...options);
				};
				const send = XMLHttpRequest.prototype.send;
				XMLHttpRequest.prototype.send = function (body) {
					if (
						this.capRecorderUploadUrl?.includes("/part/") &&
						body instanceof Blob
					) {
						const url = this.capRecorderUploadUrl;
						window.capRecorderPutBodies.push(
							body
								.arrayBuffer()
								.then((buffer) => crypto.subtle.digest("SHA-256", buffer))
								.then((digest) => ({
									url,
									bytes: body.size,
									sha256: Array.from(new Uint8Array(digest), (byte) =>
										byte.toString(16).padStart(2, "0"),
									).join(""),
								})),
						);
					}
					return send.call(this, body);
				};
			},
			{ failCameraSpool },
		);
		const page = await context.newPage();
		page.on("console", (message) => {
			if (message.type() === "error") browserErrors.push(message.text());
		});
		page.on("pageerror", (error) => browserErrors.push(error.message));
		await page.route("https://capture.test/**", async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			if (path === "/harness") {
				await route.fulfill({
					status: 200,
					contentType: "text/html",
					body: '<!doctype html><html><body><div id="root"></div><script src="/harness.js"></script></body></html>',
				});
				return;
			}
			if (path === "/harness.js") {
				await route.fulfill({
					status: 200,
					contentType: "text/javascript",
					body: bundle,
				});
				return;
			}
			if (path.startsWith("/part/")) {
				const data = request.postDataBuffer();
				parts.push({
					path,
					bytes: data?.length ?? 0,
					sha256: data ? createHash("sha256").update(data).digest("hex") : null,
				});
				await route.fulfill({
					status: 200,
					headers: { etag: '"replay-etag"' },
					body: "",
				});
				return;
			}
			if (path.startsWith("/api/upload/multipart/")) {
				const body = request.postDataJSON();
				requests.push({ path, body });
				if (path.endsWith("/initiate")) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ uploadId: body.subpath, provider: "s3" }),
					});
					return;
				}
				if (path.endsWith("/presign-part")) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({
							presignedUrl: `https://capture.test/part/${encodeURIComponent(body.subpath)}/${body.partNumber}`,
							provider: "s3",
						}),
					});
					return;
				}
				if (path.endsWith("/complete")) {
					await route.fulfill({
						status:
							failCameraCompletion && body.subpath === cameraSubpath
								? 400
								: 200,
						contentType: "application/json",
						body: JSON.stringify(
							failCameraCompletion && body.subpath === cameraSubpath
								? { error: "Simulated camera completion rejection" }
								: { success: true, processingStarted: true },
						),
					});
					return;
				}
				if (path.endsWith("/abort")) {
					await route.fulfill({
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ success: true }),
					});
					return;
				}
			}
			await route.fulfill({ status: 404, body: `Unexpected request: ${path}` });
		});

		await page.goto("https://capture.test/harness");
		try {
			await page.waitForFunction(
				() => window.capRecorderHarness?.canStartRecording === true,
			);
		} catch (error) {
			const diagnostics = await page.evaluate(() => ({
				readyState: document.readyState,
				mediaDevices: Boolean(navigator.mediaDevices),
				mediaRecorder: typeof MediaRecorder,
				harnessMounted: Boolean(window.capRecorderHarness),
			}));
			throw new Error(
				"Capture harness failed to initialize: " +
					JSON.stringify({
						engine: engine.name,
						pauseResume,
						browserErrors,
						diagnostics,
					}),
				{ cause: error },
			);
		}
		await page.evaluate(() => window.capRecorderHarness.startRecording());
		await page.waitForFunction(
			() => window.capRecorderHarness?.phase === "recording",
		);
		if (pauseResume) {
			await page.waitForTimeout(600);
			await page.evaluate(() => window.capRecorderHarness.pauseRecording());
			await page.waitForFunction(
				() => window.capRecorderHarness?.phase === "paused",
			);
			await page.waitForTimeout(350);
			await page.evaluate(() => window.capRecorderHarness.resumeRecording());
			await page.waitForFunction(
				() => window.capRecorderHarness?.phase === "recording",
			);
		}
		await page.waitForTimeout(engine.name === "WebKit" ? 5000 : 1700);
		await page.evaluate(() => window.capRecorderHarness.stopRecording());
		try {
			await page.waitForFunction(
				() => ["completed", "error"].includes(window.capRecorderHarness?.phase),
				null,
				{ timeout: 30000 },
			);
			const actualPhase = await page.evaluate(
				() => window.capRecorderHarness?.phase,
			);
			assert.equal(actualPhase, failCameraCompletion ? "error" : "completed");
		} catch (error) {
			const state = await page.evaluate(() => ({
				phase: window.capRecorderHarness?.phase,
				videoId: window.capRecorderHarness?.videoId,
				cameraDownload: Boolean(window.capRecorderHarness?.cameraErrorDownload),
				displayDownload: Boolean(window.capRecorderHarness?.errorDownload),
			}));
			throw new Error(
				"Paired capture did not reach its terminal phase: " +
					JSON.stringify({
						engine: engine.name,
						pauseResume,
						failCameraCompletion,
						browserErrors,
						state,
						requests: requests.map((request) => request.path),
						partBytes: parts.map((part) => part.bytes),
					}),
				{ cause: error },
			);
		}
		if (failCameraCompletion) {
			const evidence = await page.evaluate(async () => {
				const readBytes = async (download) =>
					download ? (await (await fetch(download.url)).blob()).size : 0;
				return {
					cameraBackupBytes: await readBytes(
						window.capRecorderHarness?.cameraErrorDownload,
					),
					displayBackupBytes: await readBytes(
						window.capRecorderHarness?.errorDownload,
					),
				};
			});
			const sentParts = await page.evaluate(() =>
				Promise.all(window.capRecorderPutBodies),
			);
			const cameraBytes = sentParts
				.filter((part) => part.url.includes(cameraSubpath))
				.reduce((total, part) => total + part.bytes, 0);
			assert.ok(cameraBytes > 0);
			assert.equal(evidence.cameraBackupBytes, cameraBytes);
			assert.ok(evidence.displayBackupBytes > 0);
			assert.ok(
				browserErrors.some((error) =>
					error.includes("Failed to upload camera recording"),
				),
			);
			return {
				engine: engine.name,
				pauseResume,
				failCameraCompletion,
				...evidence,
			};
		}
		assert.deepEqual(browserErrors, []);
		if (failCameraSpool) {
			assert.ok(
				(await page.evaluate(() => window.capRecorderCameraSpoolFailures)) > 0,
			);
		}
		const completions = requests.filter((request) =>
			request.path.endsWith("/complete"),
		);
		assert.equal(completions.length, 2);
		assert.deepEqual(
			completions.map((request) => request.body.subpath).sort(),
			[cameraSubpath, screenSubpath],
		);
		const sentParts = await page.evaluate(() =>
			Promise.all(window.capRecorderPutBodies),
		);
		const cameraParts = sentParts.filter((part) =>
			part.url.includes(cameraSubpath),
		);
		const screenParts = sentParts.filter((part) =>
			part.url.includes(screenSubpath),
		);
		const cameraBytes = cameraParts.reduce(
			(total, part) => total + part.bytes,
			0,
		);
		const screenBytes = screenParts.reduce(
			(total, part) => total + part.bytes,
			0,
		);
		assert.ok(cameraBytes > 0);
		assert.ok(screenBytes > 0);
		assert.notEqual(cameraParts[0].sha256, screenParts[0].sha256);
		if (engine.extension === "webm") {
			const cameraPart = parts.find((part) =>
				part.path.includes(cameraSubpath),
			);
			const screenPart = parts.find((part) =>
				part.path.includes(screenSubpath),
			);
			assert.ok(cameraPart?.bytes > 0);
			assert.ok(screenPart?.bytes > 0);
			assert.notEqual(cameraPart.sha256, screenPart.sha256);
		}
		const cameraComplete = completions.find(
			(request) => request.body.subpath === cameraSubpath,
		);
		const screenComplete = completions.find(
			(request) => request.body.subpath === screenSubpath,
		);
		assert.equal(cameraComplete.body.screenSubpath, screenSubpath);
		assert.equal(
			cameraComplete.body.parts.reduce((total, part) => total + part.size, 0),
			cameraBytes,
		);
		assert.equal(
			screenComplete.body.parts.reduce((total, part) => total + part.size, 0),
			screenBytes,
		);
		assert.ok(Number.isInteger(cameraComplete.body.cameraOffsetMs));
		assert.ok(Math.abs(cameraComplete.body.cameraOffsetMs) < 500);
		assert.deepEqual(
			[cameraComplete.body.width, cameraComplete.body.height],
			[320, 180],
		);
		assert.deepEqual(
			[screenComplete.body.width, screenComplete.body.height],
			[640, 360],
		);
		return {
			engine: engine.name,
			pauseResume,
			failCameraSpool,
			cameraBytes,
			screenBytes,
			cameraOffsetMs: cameraComplete.body.cameraOffsetMs,
		};
	} finally {
		await context.close();
	}
}

const bundle = await readFile(artifact, "utf8");
const requestedEngine = process.argv[2]?.toLowerCase();
const engines = [
	{ name: "Chromium", browserType: chromium, extension: "webm" },
	{ name: "WebKit", browserType: webkit, extension: "mp4" },
].filter(
	(engine) => !requestedEngine || engine.name.toLowerCase() === requestedEngine,
);
assert.ok(engines.length > 0, `Unknown browser engine: ${requestedEngine}`);
try {
	const results = [];
	for (const engine of engines) {
		const browser = await engine.browserType.launch({
			headless: process.env.CAP_REPLAY_HEADED !== "true",
		});
		try {
			for (const pauseResume of [false, true]) {
				results.push(
					await replayPairedCapture(browser, bundle, pauseResume, engine),
				);
			}
			if (engine.name === "Chromium") {
				results.push(
					await replayPairedCapture(browser, bundle, false, engine, true),
				);
			}
			if (engine.name === "WebKit") {
				results.push(
					await replayPairedCapture(
						browser,
						bundle,
						false,
						engine,
						false,
						true,
					),
				);
			}
		} finally {
			await browser.close();
		}
	}
	process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
	await rm(artifactDirectory, { recursive: true });
}
