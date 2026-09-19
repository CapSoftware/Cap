import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
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

async function replayPairedCapture(browser, bundle, pauseResume) {
	const requests = [];
	const parts = [];
	const browserErrors = [];
	const context = await browser.newContext();
	try {
		await context.addInitScript(() => {
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
			const display = createCanvasStream(640, 360, "#203060");
			const camera = createCanvasStream(320, 180, "#b02040");
			navigator.mediaDevices.getDisplayMedia = async () => display;
			navigator.mediaDevices.getUserMedia = async () => camera;
		});
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
						status: 200,
						contentType: "application/json",
						body: JSON.stringify({ success: true, processingStarted: true }),
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
		await page.waitForFunction(
			() => window.capRecorderHarness?.canStartRecording === true,
		);
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
		await page.waitForTimeout(1700);
		await page.evaluate(() => window.capRecorderHarness.stopRecording());
		await page.waitForFunction(
			() => window.capRecorderHarness?.phase === "completed",
			null,
			{ timeout: 30000 },
		);
		assert.deepEqual(browserErrors, []);
		const completions = requests.filter((request) =>
			request.path.endsWith("/complete"),
		);
		assert.equal(completions.length, 2);
		assert.deepEqual(
			completions.map((request) => request.body.subpath).sort(),
			["camera-upload.webm", "raw-upload.webm"],
		);
		const cameraPart = parts.find((part) =>
			part.path.includes("camera-upload.webm"),
		);
		const screenPart = parts.find((part) =>
			part.path.includes("raw-upload.webm"),
		);
		assert.ok(cameraPart?.bytes > 0);
		assert.ok(screenPart?.bytes > 0);
		assert.notEqual(cameraPart.sha256, screenPart.sha256);
		const cameraComplete = completions.find(
			(request) => request.body.subpath === "camera-upload.webm",
		);
		const screenComplete = completions.find(
			(request) => request.body.subpath === "raw-upload.webm",
		);
		assert.equal(cameraComplete.body.screenSubpath, "raw-upload.webm");
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
			pauseResume,
			cameraBytes: cameraPart.bytes,
			screenBytes: screenPart.bytes,
			cameraOffsetMs: cameraComplete.body.cameraOffsetMs,
		};
	} finally {
		await context.close();
	}
}

const bundle = await readFile(artifact, "utf8");
const browser = await chromium.launch({ headless: true });
try {
	const results = [];
	for (const pauseResume of [false, true]) {
		results.push(await replayPairedCapture(browser, bundle, pauseResume));
	}
	process.stdout.write(`${JSON.stringify(results)}\n`);
} finally {
	await browser.close();
	await rm(artifactDirectory, { recursive: true });
}
