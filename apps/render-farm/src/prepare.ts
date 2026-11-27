import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

const BUILTIN_FILE =
	/^(?:backgrounds\/(?:macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg|music\/[a-z0-9-]+\.mp3)$/;
const MAX_PREPARE_BYTES = 8 << 20;
const MAX_INPUT_EVENTS_BYTES = 64 << 20;

export const BUILTIN_DIR = process.env.RF_BUILTIN_DIR ?? "/opt/cap";

export function builtinPath(name: string) {
	return BUILTIN_FILE.test(name) ? join(BUILTIN_DIR, name) : null;
}

export type PrepareRequest = {
	version: 1;
	sources: Record<string, unknown>;
	display: { key: string; contentType: string };
	inputEvents: { key: string; size: number } | null;
	sessionDefaults: boolean;
};

export function parsePrepareRequest(value: unknown): PrepareRequest {
	const record = (item: unknown): item is Record<string, unknown> =>
		typeof item === "object" && item !== null && !Array.isArray(item);
	if (!record(value) || value.version !== 1 || !record(value.sources)) {
		throw new Error("prepare.json is invalid");
	}
	const display = value.display;
	if (
		!record(display) ||
		typeof display.key !== "string" ||
		(display.contentType !== "video/mp4" &&
			display.contentType !== "video/webm")
	) {
		throw new Error("prepare.json names no display");
	}
	const inputEvents = value.inputEvents;
	if (
		inputEvents !== null &&
		(!record(inputEvents) ||
			typeof inputEvents.key !== "string" ||
			typeof inputEvents.size !== "number" ||
			!Number.isSafeInteger(inputEvents.size) ||
			inputEvents.size < 1 ||
			inputEvents.size > MAX_INPUT_EVENTS_BYTES)
	) {
		throw new Error("prepare.json input events are invalid");
	}
	return {
		version: 1,
		sources: value.sources,
		display: { key: display.key, contentType: display.contentType },
		inputEvents: inputEvents as PrepareRequest["inputEvents"],
		sessionDefaults: value.sessionDefaults === true,
	};
}

type ManifestFile = { path: string; size?: number; [key: string]: unknown };

export type PrepareStorage = {
	getBounded(key: string, limit: number): Promise<Uint8Array>;
	put(
		key: string,
		body: Uint8Array | string,
		contentType?: string,
	): Promise<unknown>;
	presignGet(key: string): Promise<string>;
	inScope(key: string): boolean;
	onManifest?(manifest: { files: ManifestFile[] }): void;
};

export type PrepareDeps = PrepareStorage & {
	engine<T>(op: string, body: Record<string, unknown>): Promise<T>;
};

export type StagedPrepare = {
	manifest: { files: ManifestFile[] };
	project: string;
	engineRequest: Record<string, unknown>;
};

export async function stagePrepare(
	prefix: string,
	name: string,
	workDir: string,
	deps: PrepareStorage,
): Promise<StagedPrepare | null> {
	const manifest = JSON.parse(
		new TextDecoder().decode(
			await deps.getBounded(`${prefix}/manifest.json`, MAX_PREPARE_BYTES),
		),
	) as { files: ManifestFile[] };
	if (manifest.files.some((file) => file.path === "recording-meta.json")) {
		return null;
	}
	const request = parsePrepareRequest(
		JSON.parse(
			new TextDecoder().decode(
				await deps.getBounded(`${prefix}/${name}`, MAX_PREPARE_BYTES),
			),
		),
	);
	for (const key of [request.display.key, request.inputEvents?.key]) {
		if (key !== undefined && !deps.inScope(key)) {
			throw new Error("prepare.json names a source outside the recording");
		}
	}
	deps.onManifest?.(manifest);
	mkdirSync(workDir, { recursive: true });
	const project = join(workDir, "prepared");
	let inputEvents: string | undefined;
	if (request.inputEvents) {
		const bytes = await deps.getBounded(
			request.inputEvents.key,
			MAX_INPUT_EVENTS_BYTES,
		);
		if (bytes.byteLength !== request.inputEvents.size) {
			throw new Error("input events changed size");
		}
		inputEvents = join(workDir, "input-events.ndjson");
		writeFileSync(inputEvents, bytes);
	}
	return {
		manifest,
		project,
		engineRequest: {
			project,
			sources: request.sources,
			input_events: inputEvents,
			display_source: await deps.presignGet(request.display.key),
			display_content_type: request.display.contentType,
			session_defaults: request.sessionDefaults,
		},
	};
}

export async function prepareRecording(
	prefix: string,
	name: string,
	workDir: string,
	deps: PrepareDeps,
) {
	const staged = await stagePrepare(prefix, name, workDir, deps);
	if (!staged) return false;
	const { manifest, project } = staged;
	const written = await deps.engine<{
		files: { path: string; size: number }[];
	}>("prepare", staged.engineRequest);
	const listed = new Set(manifest.files.map((file) => file.path));
	await Promise.all(
		written.files.map((file) =>
			deps.put(
				`${prefix}/${file.path}`,
				readFileSync(join(project, file.path)),
				file.path.endsWith(".json")
					? "application/json"
					: "application/octet-stream",
			),
		),
	);
	await deps.put(
		`${prefix}/manifest.json`,
		JSON.stringify({
			files: [
				...manifest.files,
				...written.files.filter((file) => !listed.has(file.path)),
			],
		}),
		"application/json",
	);
	return true;
}

export async function prepareSupport(
	engine: <T>(op: string, body: Record<string, unknown>) => Promise<T>,
) {
	const defaultConfig = await engine<Record<string, unknown>>(
		"default_config",
		{},
	);
	const musicDir = join(BUILTIN_DIR, "music");
	const music = existsSync(musicDir)
		? (await Array.fromAsync(new Bun.Glob("*.mp3").scan(musicDir)))
				.map((file) => file.slice(0, -".mp3".length))
				.filter((id) => builtinPath(`music/${id}.mp3`) !== null)
				.sort()
		: [];
	return { version: 1 as const, defaultConfig, music };
}

export function builtinSize(name: string) {
	const path = builtinPath(name);
	if (!path || !existsSync(path)) {
		throw new Error(`built-in asset ${name} is not on this machine`);
	}
	return { path, size: statSync(path).size };
}
