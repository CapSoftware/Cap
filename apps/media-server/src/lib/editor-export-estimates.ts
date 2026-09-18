import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { editorExportSettingsSchema } from "./editor-exports";
import {
	nativeEditorBinary,
	type startNativeEditorSession,
} from "./editor-native";

type NativeSession = Awaited<ReturnType<typeof startNativeEditorSession>>;
export type EditorExportEstimate = {
	duration_seconds: number;
	estimated_time_seconds: number;
	estimated_size_mb: number;
	time_range_seconds: [number, number];
	size_range_mb: [number, number];
};
type ActiveEstimate = { controller: AbortController; done: Promise<void> };

const active = new Map<string, ActiveEstimate>();
const cache = new Map<
	string,
	{ result: EditorExportEstimate; expiresAt: number }
>();
const ESTIMATE_TIMEOUT_MS = 30_000;
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHED_ESTIMATES = 64;

function isEstimate(value: unknown): value is EditorExportEstimate {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Record<string, unknown>;
	const fields = [
		"duration_seconds",
		"estimated_time_seconds",
		"estimated_size_mb",
	] as const;
	if (
		fields.some((field) => {
			const item = candidate[field];
			return typeof item !== "number" || !Number.isFinite(item) || item < 0;
		}) ||
		!("time_range_seconds" in value) ||
		!("size_range_mb" in value)
	) {
		return false;
	}
	return [value.time_range_seconds, value.size_range_mb].every(
		(range) =>
			Array.isArray(range) &&
			range.length === 2 &&
			range.every(
				(item) =>
					typeof item === "number" && Number.isFinite(item) && item >= 0,
			),
	);
}

function channelId(value: unknown) {
	if (typeof value !== "string") return null;
	const match = /^__CHANNEL__:(\d+)$/.exec(value);
	if (!match) return null;
	const id = Number(match[1]);
	return Number.isSafeInteger(id) ? id : null;
}

export function cancelEditorExportEstimate(sessionId: string) {
	active.get(sessionId)?.controller.abort();
}

export async function getEditorExportEstimate(
	sessionId: string,
	native: NativeSession,
	args: unknown[],
	socketSignal: AbortSignal,
	onEstimate: (channel: number, value: EditorExportEstimate) => void,
) {
	const [projectPath, settingsInput, channel] = args;
	const id = channelId(channel);
	if (projectPath !== `cap-web-editor://session/${sessionId}` || id === null) {
		throw new Error("Invalid editor export estimate request");
	}
	const settings = editorExportSettingsSchema.parse(settingsInput);
	const previous = active.get(sessionId);
	previous?.controller.abort();
	const controller = new AbortController();
	let finish = () => {};
	const done = new Promise<void>((resolve) => {
		finish = resolve;
	});
	const current = { controller, done };
	active.set(sessionId, current);
	const signal = AbortSignal.any([
		controller.signal,
		socketSignal,
		AbortSignal.timeout(ESTIMATE_TIMEOUT_MS),
	]);
	let root: string | null = null;
	try {
		await previous?.done;
		if (signal.aborted) throw new Error("Export estimate canceled");
		const config = await readFile(
			join(native.projectPath, "project-config.json"),
		);
		const key = createHash("sha256")
			.update(native.projectPath)
			.update("\0")
			.update(config)
			.update("\0")
			.update(JSON.stringify(settings))
			.digest("hex");
		const cached = cache.get(key);
		if (cached && cached.expiresAt > Date.now()) {
			onEstimate(id, cached.result);
			return cached.result;
		}
		root = await mkdtemp(join(tmpdir(), "cap-editor-estimate-"));
		await chmod(root, 0o700);
		const configPath = join(root, "project-config.json");
		const settingsPath = join(root, "settings.json");
		await Promise.all([
			writeFile(configPath, config, { flag: "wx", mode: 0o600 }),
			writeFile(settingsPath, JSON.stringify(settings), {
				flag: "wx",
				mode: 0o600,
			}),
		]);
		if (signal.aborted) throw new Error("Export estimate canceled");
		const child = spawn(
			nativeEditorBinary("prepare"),
			["estimate", native.projectPath, configPath, settingsPath],
			{ stdio: ["pipe", "pipe", "pipe"] },
		);
		child.stdin.end();
		const abort = () => child.kill("SIGTERM");
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4096);
		});
		let result: EditorExportEstimate | null = null;
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			let output: unknown;
			try {
				output = JSON.parse(line);
			} catch {
				return;
			}
			if (
				typeof output !== "object" ||
				output === null ||
				!("kind" in output) ||
				!("value" in output) ||
				!isEstimate(output.value)
			) {
				return;
			}
			if (output.kind === "estimate" && !signal.aborted) {
				onEstimate(id, output.value);
			} else if (output.kind === "result") {
				result = output.value;
			}
		});
		let spawnError: Error | null = null;
		child.once("error", (cause) => {
			spawnError = cause;
		});
		const code = await new Promise<number | null>((resolve) => {
			child.once("close", resolve);
		});
		signal.removeEventListener("abort", abort);
		lines.close();
		if (signal.aborted) throw new Error("Export estimate canceled");
		if (spawnError || code !== 0 || !result) {
			throw spawnError || new Error(stderr || "Native export estimate failed");
		}
		cache.set(key, { result, expiresAt: Date.now() + CACHE_TTL_MS });
		if (cache.size > MAX_CACHED_ESTIMATES) {
			cache.delete(cache.keys().next().value ?? "");
		}
		return result;
	} finally {
		if (root) await rm(root, { recursive: true, force: true });
		finish();
		if (active.get(sessionId) === current) active.delete(sessionId);
	}
}
