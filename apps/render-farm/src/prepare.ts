import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

// A recording the web app didn't prepare on an editor worker arrives with
// `prepare.json` (what the worker would have been given) and a manifest of
// the recording's own files. The engine writes the project files the worker
// would have staged (metadata, config, pointer input) and the coordinator
// publishes them next to the media before planning.

const BUILTIN_FILE =
	/^(?:backgrounds\/(?:macOS|blue|purple|cities|dark|orange)\/[a-z0-9-]+\.jpg|music\/[a-z0-9-]+\.mp3)$/;
const MAX_PREPARE_BYTES = 8 << 20;
const MAX_INPUT_EVENTS_BYTES = 64 << 20;

export const BUILTIN_DIR = process.env.RF_BUILTIN_DIR ?? "/opt/cap";

/** Where a built-in asset lives on this machine, or null when it isn't one. */
export function builtinPath(name: string) {
	return BUILTIN_FILE.test(name) ? join(BUILTIN_DIR, name) : null;
}

export type PrepareRequest = {
	version: 1;
	sources: Record<string, unknown>;
	display: { key: string; contentType: string };
	inputEvents: { key: string; size: number } | null;
	/** Never edited: open with the timeline and offsets a session fills in. */
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

export type PrepareDeps = {
	/** Reads a whole object, refusing ones larger than the limit. */
	getBounded(key: string, limit: number): Promise<Uint8Array>;
	put(
		key: string,
		body: Uint8Array | string,
		contentType?: string,
	): Promise<unknown>;
	presignGet(key: string): Promise<string>;
	/** Checks a key lies inside the recording's folder. */
	inScope(key: string): boolean;
	engine<T>(op: string, body: Record<string, unknown>): Promise<T>;
	/**
	 * Sees the recording's own files before the engine runs, so work that
	 * needs only them (video transcodes) starts alongside.
	 */
	onManifest?(manifest: { files: ManifestFile[] }): void;
};

/**
 * Writes and publishes the project files for a recording that ships
 * `prepare.json`, and adds them to its manifest. Returns false when the
 * manifest already lists them (a job resumed after a restart).
 */
export async function prepareRecording(
	prefix: string,
	name: string,
	workDir: string,
	deps: PrepareDeps,
) {
	const manifest = JSON.parse(
		new TextDecoder().decode(
			await deps.getBounded(`${prefix}/manifest.json`, MAX_PREPARE_BYTES),
		),
	) as { files: ManifestFile[] };
	if (manifest.files.some((file) => file.path === "recording-meta.json")) {
		return false;
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
	const written = await deps.engine<{
		files: { path: string; size: number }[];
	}>("prepare", {
		project,
		sources: request.sources,
		input_events: inputEvents,
		display_source: await deps.presignGet(request.display.key),
		display_content_type: request.display.contentType,
		session_defaults: request.sessionDefaults,
	});
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

/** The capability /health advertises, once the engine can prepare projects. */
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
