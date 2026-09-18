import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmod,
	lstat,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import {
	nativeEditorBinary,
	type startNativeEditorSession,
} from "./editor-native";

const runFile = promisify(execFile);
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const PREVIEW_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 60_000;
const MAX_CACHED_PREVIEWS = 32;

const settingsSchema = z.object({
	fps: z.number().int().min(1).max(60),
	resolution_base: z.object({
		x: z.number().int().min(1).max(3840),
		y: z.number().int().min(1).max(2160),
	}),
	compression_bpp: z.number().finite().min(0).max(1),
	cursor_only: z.boolean().optional(),
});

type NativeSession = Awaited<ReturnType<typeof startNativeEditorSession>>;
type PreviewResult = {
	jpeg_base64: string;
	estimated_size_mb: number;
	actual_width: number;
	actual_height: number;
	frame_render_time_ms: number;
	total_frames: number;
};
const active = new Map<string, AbortController>();
const cache = new Map<string, { result: PreviewResult; expiresAt: number }>();

function parsePreviewOutput(value: unknown) {
	if (
		typeof value !== "object" ||
		value === null ||
		!("actualWidth" in value) ||
		!("actualHeight" in value) ||
		!("frameRenderTimeMs" in value) ||
		!("totalFrames" in value) ||
		!("estimatedSizeMb" in value) ||
		typeof value.actualWidth !== "number" ||
		typeof value.actualHeight !== "number" ||
		typeof value.frameRenderTimeMs !== "number" ||
		typeof value.totalFrames !== "number" ||
		typeof value.estimatedSizeMb !== "number" ||
		!Number.isSafeInteger(value.actualWidth) ||
		!Number.isSafeInteger(value.actualHeight) ||
		!Number.isSafeInteger(value.totalFrames) ||
		value.actualWidth < 1 ||
		value.actualHeight < 1 ||
		value.totalFrames < 1 ||
		!Number.isFinite(value.frameRenderTimeMs) ||
		value.frameRenderTimeMs < 0 ||
		!Number.isFinite(value.estimatedSizeMb) ||
		value.estimatedSizeMb < 0
	) {
		throw new Error("Native export preview returned invalid dimensions");
	}
	return {
		actual_width: value.actualWidth,
		actual_height: value.actualHeight,
		frame_render_time_ms: value.frameRenderTimeMs,
		total_frames: value.totalFrames,
		estimated_size_mb: value.estimatedSizeMb,
	};
}

export async function renderEditorExportPreview(
	sessionId: string,
	native: NativeSession,
	frameTime: unknown,
	settingsInput: unknown,
	socketSignal: AbortSignal,
): Promise<PreviewResult> {
	if (
		typeof frameTime !== "number" ||
		!Number.isFinite(frameTime) ||
		frameTime < 0 ||
		frameTime > 36_000
	) {
		throw new Error("Invalid export preview frame time");
	}
	const settings = settingsSchema.parse(settingsInput);
	const projectConfigPath = join(native.projectPath, "project-config.json");
	const config = await readFile(projectConfigPath);
	const key = createHash("sha256")
		.update(native.projectPath)
		.update("\0")
		.update(config)
		.update("\0")
		.update(String(frameTime))
		.update("\0")
		.update(JSON.stringify(settings))
		.digest("hex");
	active.get(sessionId)?.abort();
	const cached = cache.get(key);
	if (cached && cached.expiresAt > Date.now()) return cached.result;
	const controller = new AbortController();
	active.set(sessionId, controller);
	const signal = AbortSignal.any([
		controller.signal,
		socketSignal,
		AbortSignal.timeout(PREVIEW_TIMEOUT_MS),
	]);
	const root = await mkdtemp(join(tmpdir(), "cap-editor-preview-"));
	try {
		await chmod(root, 0o700);
		const settingsPath = join(root, "settings.json");
		const configPath = join(root, "project-config.json");
		const outputPath = join(root, "preview.jpg");
		await Promise.all([
			writeFile(settingsPath, JSON.stringify(settings), {
				flag: "wx",
				mode: 0o600,
			}),
			writeFile(configPath, config, { flag: "wx", mode: 0o600 }),
		]);
		const { stdout } = await runFile(
			nativeEditorBinary("prepare"),
			[
				"preview",
				native.projectPath,
				configPath,
				String(frameTime),
				settingsPath,
				outputPath,
			],
			{ signal, maxBuffer: 64 * 1024 },
		);
		if (signal.aborted) throw new Error("Export preview was canceled");
		let metadata: unknown;
		try {
			metadata = JSON.parse(stdout.trim());
		} catch {
			throw new Error("Native export preview returned invalid metadata");
		}
		const dimensions = parsePreviewOutput(metadata);
		const file = await lstat(outputPath);
		if (!file.isFile() || file.size === 0 || file.size > MAX_PREVIEW_BYTES) {
			throw new Error("Native export preview image was invalid");
		}
		const image = await readFile(outputPath);
		const result: PreviewResult = {
			...dimensions,
			jpeg_base64: image.toString("base64"),
		};
		cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
		if (cache.size > MAX_CACHED_PREVIEWS) {
			cache.delete(cache.keys().next().value ?? "");
		}
		return result;
	} finally {
		if (active.get(sessionId) === controller) active.delete(sessionId);
		await rm(root, { recursive: true, force: true });
	}
}
