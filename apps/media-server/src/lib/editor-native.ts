import { type ChildProcessByStdio, execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import {
	type EditorAudioAsset,
	stageSignedEditorAudioAsset,
} from "./editor-assets";
import { stageSavedEditorAudioLibrary } from "./editor-audio-library";
import {
	type EditorCapAsset,
	stageSignedEditorCapAsset,
	validateEditorCapAsset,
} from "./editor-cap-assets";
import { mapEditorConfigPaths } from "./editor-config-paths";
import {
	type EditorImageAsset,
	stageSignedEditorImageAsset,
} from "./editor-image-assets";
import {
	type EditorVideoAsset,
	stageSignedEditorVideoAsset,
} from "./editor-video-assets";

const runFile = promisify(execFile);
const STARTUP_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 5_000;
const CLIP_VIDEO_PATH =
	/^content\/videos\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(mp4|webm)$/;

type MediaInput = {
	path: string;
	contentType: "video/webm" | "video/mp4";
	size: number;
	fps: number;
};

type AudioMediaInput = {
	path: string;
	contentType: "audio/webm" | "audio/mp4";
	size: number;
	offsetMs: number;
};

export type NativeEditorClipInput = {
	displayPath: string;
	duration: number;
	fps: number;
	hasAudio: boolean;
	cameraPath?: string;
	cameraFps?: number;
	cameraOffsetMs?: number;
};

export type NativeEditorImport =
	| { kind: "clip"; clip: NativeEditorClipInput }
	| { kind: "cap"; asset: EditorCapAsset; clipCount: number };

export type LegacyEditorEditSpec = {
	version: 1;
	sourceDuration: number;
	keepRanges: Array<{ start: number; end: number }>;
};

export type NativeEditorInputs = {
	title: string;
	display: MediaInput;
	camera?: MediaInput & { offsetMs: number };
	mic?: AudioMediaInput;
	systemAudio?: AudioMediaInput;
	mixedAudioInDisplay: boolean;
	projectConfig?: Record<string, unknown>;
	legacyEditSpec?: LegacyEditorEditSpec;
	audioAssets?: EditorAudioAsset[];
	imageAssets?: EditorImageAsset[];
	videoAssets?: EditorVideoAsset[];
	clips?: NativeEditorClipInput[];
	imports?: NativeEditorImport[];
};

export type NativeEditorProject = {
	path: string;
	cleanup: () => Promise<void>;
};

export function nativeEditorBinary(name: "prepare" | "service") {
	const value =
		name === "prepare"
			? process.env.CAP_WEB_EDITOR_PREPARE_BIN
			: process.env.CAP_WEB_EDITOR_SERVICE_BIN;
	if (!value) throw new Error(`Native editor ${name} binary is unavailable`);
	return value;
}

async function validateInput(input: MediaInput) {
	if (
		!Number.isSafeInteger(input.size) ||
		input.size <= 0 ||
		!Number.isSafeInteger(input.fps) ||
		input.fps <= 0 ||
		input.fps > 120
	) {
		throw new Error("Invalid editor media dimensions");
	}
	const extension = input.contentType === "video/mp4" ? ".mp4" : ".webm";
	if (extname(input.path).toLowerCase() !== extension) {
		throw new Error("Editor media extension does not match its content type");
	}
	const metadata = await lstat(input.path);
	if (!metadata.isFile() || metadata.size !== input.size) {
		throw new Error("Editor media file changed before project preparation");
	}
}

async function validateAudioInput(input: AudioMediaInput) {
	if (
		!Number.isSafeInteger(input.size) ||
		input.size <= 0 ||
		!Number.isSafeInteger(input.offsetMs) ||
		Math.abs(input.offsetMs) > 30_000
	) {
		throw new Error("Invalid editor audio source");
	}
	const extension = input.contentType === "audio/mp4" ? ".mp4" : ".webm";
	if (extname(input.path).toLowerCase() !== extension) {
		throw new Error("Editor audio extension does not match its content type");
	}
	const metadata = await lstat(input.path);
	if (!metadata.isFile() || metadata.size !== input.size) {
		throw new Error("Editor audio file changed before project preparation");
	}
}

export async function prepareNativeEditorProject(
	inputs: NativeEditorInputs,
	abortSignal?: AbortSignal,
): Promise<NativeEditorProject> {
	await Promise.all([
		validateInput(inputs.display),
		...(inputs.camera ? [validateInput(inputs.camera)] : []),
		...(inputs.mic ? [validateAudioInput(inputs.mic)] : []),
		...(inputs.systemAudio ? [validateAudioInput(inputs.systemAudio)] : []),
	]);
	if (
		inputs.mixedAudioInDisplay &&
		(inputs.mic !== undefined || inputs.systemAudio !== undefined)
	) {
		throw new Error("Mixed display audio cannot be added twice");
	}
	if (
		inputs.camera &&
		(!Number.isSafeInteger(inputs.camera.offsetMs) ||
			Math.abs(inputs.camera.offsetMs) > 30_000)
	) {
		throw new Error("Invalid webcam recording offset");
	}
	const clips =
		inputs.imports?.flatMap((item) =>
			item.kind === "clip" ? [item.clip] : [],
		) ??
		inputs.clips ??
		[];
	const capImports =
		inputs.imports?.filter((item) => item.kind === "cap") ?? [];
	const assetPaths = new Set(
		(inputs.videoAssets ?? []).map((asset) => asset.path),
	);
	if (
		(inputs.imports !== undefined && inputs.clips !== undefined) ||
		(inputs.imports?.length ?? 0) > 100 ||
		clips.length > 49 ||
		capImports.reduce((total, item) => total + item.clipCount, clips.length) >
			1000 ||
		new Set(capImports.map((item) => item.asset.path)).size !==
			capImports.length ||
		capImports.some(
			(item) =>
				!Number.isSafeInteger(item.clipCount) ||
				item.clipCount < 1 ||
				item.clipCount > 1000,
		) ||
		new Set(clips.map((clip) => clip.displayPath)).size !== clips.length ||
		clips.some(
			(clip) =>
				!CLIP_VIDEO_PATH.test(clip.displayPath) ||
				!assetPaths.has(clip.displayPath) ||
				!Number.isFinite(clip.duration) ||
				clip.duration <= 0 ||
				clip.duration > 86_400 ||
				!Number.isSafeInteger(clip.fps) ||
				clip.fps < 1 ||
				clip.fps > 120 ||
				typeof clip.hasAudio !== "boolean" ||
				(clip.cameraPath !== undefined &&
					(!CLIP_VIDEO_PATH.test(clip.cameraPath) ||
						clip.cameraPath === clip.displayPath ||
						!assetPaths.has(clip.cameraPath) ||
						!Number.isSafeInteger(clip.cameraFps) ||
						!Number.isSafeInteger(clip.cameraOffsetMs) ||
						clip.cameraFps === undefined ||
						clip.cameraFps < 1 ||
						clip.cameraFps > 120 ||
						clip.cameraOffsetMs === undefined ||
						Math.abs(clip.cameraOffsetMs) > 30_000)) ||
				(clip.cameraPath === undefined &&
					(clip.cameraFps !== undefined || clip.cameraOffsetMs !== undefined)),
		)
	) {
		throw new Error("Invalid persisted editor recording clips");
	}
	for (const item of capImports) validateEditorCapAsset(item.asset);
	const root = await mkdtemp(join(tmpdir(), "cap-web-editor-"));
	await chmod(root, 0o700);
	const projectPath = join(root, `${randomUUID()}.cap`);
	const manifestPath = join(root, "manifest.json");
	const cleanup = () => rm(root, { recursive: true, force: true });
	try {
		await writeFile(
			manifestPath,
			JSON.stringify({
				version: 1,
				title: inputs.title,
				displayPath: inputs.display.path,
				displayFps: inputs.display.fps,
				cameraPath: inputs.camera?.path ?? null,
				cameraFps: inputs.camera?.fps ?? null,
				cameraOffsetMs: inputs.camera?.offsetMs ?? null,
				micPath: inputs.mic?.path ?? null,
				micOffsetMs: inputs.mic?.offsetMs ?? null,
				systemAudioPath: inputs.systemAudio?.path ?? null,
				systemAudioOffsetMs: inputs.systemAudio?.offsetMs ?? null,
				mixedAudioInDisplay: inputs.mixedAudioInDisplay,
				initialProjectConfig:
					inputs.projectConfig && capImports.length === 0
						? mapEditorConfigPaths(inputs.projectConfig, "native", projectPath)
						: null,
				legacyEditSpec: inputs.projectConfig
					? null
					: (inputs.legacyEditSpec ?? null),
			}),
			{ flag: "wx", mode: 0o600 },
		);
		await runFile(
			nativeEditorBinary("prepare"),
			["prepare", projectPath, manifestPath],
			{
				timeout: STARTUP_TIMEOUT_MS,
				maxBuffer: 64 * 1024,
				signal: abortSignal,
			},
		);
		await stageSavedEditorAudioLibrary(projectPath, inputs.projectConfig);
		for (const asset of inputs.audioAssets ?? []) {
			await stageSignedEditorAudioAsset(projectPath, asset, abortSignal);
		}
		for (const asset of inputs.imageAssets ?? []) {
			await stageSignedEditorImageAsset(projectPath, asset, abortSignal);
		}
		for (const asset of inputs.videoAssets ?? []) {
			await stageSignedEditorVideoAsset(projectPath, asset, abortSignal);
		}
		if (inputs.imports) {
			for (const [index, item] of inputs.imports.entries()) {
				if (item.kind === "clip") {
					const clipManifestPath = join(root, `clip-${index}.json`);
					await writeFile(
						clipManifestPath,
						JSON.stringify({
							version: 1,
							clips: [
								{
									...item.clip,
									displayPath: join(projectPath, item.clip.displayPath),
									...(item.clip.cameraPath
										? { cameraPath: join(projectPath, item.clip.cameraPath) }
										: {}),
								},
							],
						}),
						{ flag: "wx", mode: 0o600 },
					);
					await runFile(
						nativeEditorBinary("prepare"),
						["append-clip", projectPath, clipManifestPath],
						{ timeout: 60_000, maxBuffer: 64 * 1024, signal: abortSignal },
					);
				} else {
					const staged = await stageSignedEditorCapAsset(
						projectPath,
						item.asset,
						abortSignal,
					);
					try {
						const { stdout } = await runFile(
							nativeEditorBinary("prepare"),
							["append-cap", projectPath, staged.path],
							{
								timeout: 30 * 60 * 1000,
								maxBuffer: 64 * 1024,
								signal: abortSignal,
							},
						);
						const value: unknown = JSON.parse(stdout.toString());
						if (
							typeof value !== "object" ||
							value === null ||
							!("clipCount" in value) ||
							value.clipCount !== item.clipCount
						) {
							throw new Error("Persisted Cap project clip count changed");
						}
					} finally {
						await staged.cleanup();
					}
				}
			}
			if (capImports.length > 0 && inputs.projectConfig) {
				const restoredConfigPath = join(root, "restored-project-config.json");
				await writeFile(
					restoredConfigPath,
					JSON.stringify(
						mapEditorConfigPaths(inputs.projectConfig, "native", projectPath),
					),
					{ flag: "wx", mode: 0o600 },
				);
				await rename(
					restoredConfigPath,
					join(projectPath, "project-config.json"),
				);
			}
		} else if (inputs.clips?.length) {
			const clipManifestPath = join(root, "clips-manifest.json");
			await writeFile(
				clipManifestPath,
				JSON.stringify({
					version: 1,
					clips: inputs.clips.map((clip) => ({
						...clip,
						displayPath: join(projectPath, clip.displayPath),
						...(clip.cameraPath
							? { cameraPath: join(projectPath, clip.cameraPath) }
							: {}),
					})),
				}),
				{ flag: "wx", mode: 0o600 },
			);
			await runFile(
				nativeEditorBinary("prepare"),
				["append-clips", projectPath, clipManifestPath],
				{
					timeout: 60_000,
					maxBuffer: 64 * 1024,
					signal: abortSignal,
				},
			);
		}
		return { path: projectPath, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}

function parseLoopbackAddress(input: string) {
	let data: unknown;
	try {
		data = JSON.parse(input);
	} catch {
		throw new Error("Native editor returned an invalid startup message");
	}
	if (
		typeof data !== "object" ||
		data === null ||
		!("address" in data) ||
		typeof data.address !== "string"
	) {
		throw new Error("Native editor did not publish its listening address");
	}
	const url = new URL(`http://${data.address}`);
	if (
		url.hostname !== "127.0.0.1" ||
		!url.port ||
		!Number.isInteger(Number(url.port)) ||
		Number(url.port) < 1 ||
		Number(url.port) > 65_535 ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new Error("Native editor published a non-loopback address");
	}
	return url.origin;
}

function waitForStartup(child: ChildProcessByStdio<null, Readable, Readable>) {
	return new Promise<string>((resolve, reject) => {
		let output = "";
		let settled = false;
		const finish = (error?: Error, address?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			child.stdout.off("data", onData);
			child.off("error", onError);
			child.off("exit", onExit);
			if (error) reject(error);
			else resolve(address ?? "");
		};
		const onData = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > 4096) {
				finish(new Error("Native editor startup message is too large"));
				return;
			}
			const newline = output.indexOf("\n");
			if (newline < 0) return;
			try {
				finish(undefined, parseLoopbackAddress(output.slice(0, newline)));
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		};
		const onError = (error: Error) => finish(error);
		const onExit = () =>
			finish(new Error("Native editor exited before startup"));
		const timer = setTimeout(
			() => finish(new Error("Native editor startup timed out")),
			STARTUP_TIMEOUT_MS,
		);
		child.stdout.on("data", onData);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

function waitForExit(exit: Promise<void>, timeoutMs: number) {
	return new Promise<boolean>((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		exit.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

export async function startNativeEditorSession(project: NativeEditorProject) {
	const internalToken = randomBytes(32).toString("base64url");
	const child = spawn(nativeEditorBinary("service"), [project.path], {
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, CAP_WEB_EDITOR_INTERNAL_TOKEN: internalToken },
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => {
		stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
	});
	let closed = false;
	const exit = new Promise<void>((resolve) =>
		child.once("close", () => resolve()),
	);
	let closePromise: Promise<void> | null = null;
	const close = () => {
		closePromise ??= (async () => {
			closed = true;
			if (child.exitCode === null && child.signalCode === null)
				child.kill("SIGTERM");
			if (!(await waitForExit(exit, STOP_TIMEOUT_MS))) {
				child.kill("SIGKILL");
				if (!(await waitForExit(exit, STOP_TIMEOUT_MS))) {
					throw new Error("Native editor did not exit after termination");
				}
			}
			await project.cleanup();
		})();
		return closePromise;
	};
	try {
		const origin = await waitForStartup(child);
		const authorizedHeaders = (headers?: HeadersInit) => {
			const result = new Headers(headers);
			result.set("Authorization", `Bearer ${internalToken}`);
			return result;
		};
		const health = await fetch(`${origin}/health`, {
			headers: authorizedHeaders(),
			signal: AbortSignal.timeout(STARTUP_TIMEOUT_MS),
		});
		if (!health.ok)
			throw new Error(`Native editor health failed: ${health.status}`);
		void exit
			.then(() => close())
			.catch((error) => {
				console.error("Native editor cleanup failed", error);
			});
		return {
			origin,
			pid: child.pid ?? null,
			projectPath: project.path,
			request: (path: string, init?: RequestInit) => {
				if (closed) throw new Error("Native editor session is closed");
				if (!path.startsWith("/") || path.startsWith("//")) {
					throw new Error("Invalid native editor request path");
				}
				return fetch(`${origin}${path}`, {
					...init,
					headers: authorizedHeaders(init?.headers),
				});
			},
			connectSocket: (url: string) => {
				if (closed) throw new Error("Native editor session is closed");
				const upstream = new URL(url);
				const expected = new URL(origin);
				if (
					upstream.protocol !== "ws:" ||
					upstream.host !== expected.host ||
					upstream.hostname !== "127.0.0.1"
				) {
					throw new Error("Invalid native editor socket address");
				}
				const BunWebSocket = WebSocket as unknown as new (
					address: string,
					options: Bun.WebSocketOptions,
				) => WebSocket;
				return new BunWebSocket(url, {
					headers: { Authorization: `Bearer ${internalToken}` },
				});
			},
			close,
		};
	} catch (error) {
		await close();
		throw new Error(
			`Failed to start native editor: ${error instanceof Error ? error.message : String(error)}${stderr ? `; ${stderr}` : ""}`,
		);
	}
}
