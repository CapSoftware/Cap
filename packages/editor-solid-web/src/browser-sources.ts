import {
	type EditorDefaultStyle,
	parseDefaultStyle,
} from "@cap/editor-cap-bundle/default-style";
import type {
	BrowserVideoSource,
	BrowserVideoSourceProvider,
	BrowserVideoTrack,
} from "./browser-video-pool";

export type BrowserSourceSegment = {
	display: BrowserVideoSource | null;
	camera: BrowserVideoSource | null;
	displayFps: number | null;
	cameraFps: number | null;
	cameraOffsetMs: number | null;
	micOffsetMs: number | null;
	systemAudioOffsetMs: number | null;
	duration: number | null;
	hasAudio: boolean;
};

export type BrowserEditorSources = {
	videoId: string;
	title: string;
	captionsEnabled: boolean;
	projectConfig: unknown;
	defaultStyle: EditorDefaultStyle | null;
	displayHasAudio: boolean;
	mic: BrowserAudioTrack | null;
	systemAudio: BrowserAudioTrack | null;
	inputEvents: BrowserVideoSource | null;
	segments: BrowserSourceSegment[];
	expiresAt: number;
};

export type BrowserAudioTrack = BrowserVideoSource & {
	offsetMs: number;
};

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

function signedVideo(value: unknown, expiresAt: number) {
	const source = record(value);
	if (
		!source ||
		(source.contentType !== "video/mp4" &&
			source.contentType !== "video/webm") ||
		typeof source.url !== "string" ||
		source.url.length > 8192
	) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		return null;
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.hash
	) {
		return null;
	}
	return { url: url.href, expiresAt } satisfies BrowserVideoSource;
}

function signedInputEvents(value: unknown, expiresAt: number) {
	if (value === undefined || value === null) return null;
	const source = record(value);
	if (
		!source ||
		source.contentType !== "application/x-ndjson" ||
		typeof source.url !== "string" ||
		source.url.length > 8192
	) {
		throw new Error("Editor input events are invalid");
	}
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		throw new Error("Editor input events URL is invalid");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error("Editor input events URL is invalid");
	}
	return { url: url.href, expiresAt } satisfies BrowserVideoSource;
}

function validFps(value: unknown): value is number {
	return (
		Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 120
	);
}

function validOffset(value: unknown): value is number {
	return Number.isSafeInteger(value) && Math.abs(Number(value)) <= 30_000;
}

function signedAudio(
	value: unknown,
	expiresAt: number,
): BrowserAudioTrack | null {
	if (value === undefined || value === null) return null;
	const source = record(value);
	if (
		!source ||
		(source.contentType !== "audio/webm" &&
			source.contentType !== "audio/mp4") ||
		!validOffset(source.offsetMs) ||
		typeof source.url !== "string" ||
		source.url.length > 8192
	) {
		throw new Error("Editor audio source is invalid");
	}
	let url: URL;
	try {
		url = new URL(source.url);
	} catch {
		throw new Error("Editor audio source URL is invalid");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.hash
	) {
		throw new Error("Editor audio source URL is invalid");
	}
	return {
		url: url.href,
		expiresAt,
		offsetMs: source.offsetMs,
	};
}

function clipSegment(
	value: unknown,
	assets: Map<string, BrowserVideoSource>,
): BrowserSourceSegment {
	const clip = record(value);
	if (
		!validFps(clip?.fps) ||
		typeof clip?.duration !== "number" ||
		!Number.isFinite(clip.duration) ||
		clip.duration <= 0 ||
		clip.duration > 86_400 ||
		typeof clip.hasAudio !== "boolean"
	) {
		throw new Error("Editor clip timing is invalid");
	}
	const display =
		clip && typeof clip.displayPath === "string"
			? assets.get(clip.displayPath)
			: undefined;
	if (!display) throw new Error("Editor clip display source is unavailable");
	let camera: BrowserVideoSource | null = null;
	if (clip?.cameraPath !== undefined && clip.cameraPath !== null) {
		if (typeof clip.cameraPath !== "string") {
			throw new Error("Editor clip camera source is invalid");
		}
		if (!validFps(clip.cameraFps) || !validOffset(clip.cameraOffsetMs)) {
			throw new Error("Editor clip camera timing is invalid");
		}
		camera = assets.get(clip.cameraPath) ?? null;
		if (!camera) throw new Error("Editor clip camera source is unavailable");
	}
	return {
		display,
		camera,
		displayFps: clip.fps,
		cameraFps: camera ? (clip.cameraFps as number) : null,
		cameraOffsetMs: camera ? (clip.cameraOffsetMs as number) : null,
		micOffsetMs: null,
		systemAudioOffsetMs: null,
		duration: clip.duration,
		hasAudio: clip.hasAudio,
	};
}

export function parseBrowserEditorSources(
	value: unknown,
	expectedVideoId: string,
): BrowserEditorSources {
	const response = record(value);
	const sources = record(response?.sources);
	const expiresAt = sources?.signedUrlExpiresAt;
	if (
		response?.videoId !== expectedVideoId ||
		sources?.videoId !== expectedVideoId ||
		typeof expiresAt !== "number" ||
		!Number.isSafeInteger(expiresAt) ||
		expiresAt <= Date.now() + 10_000 ||
		expiresAt > Date.now() + 24 * 60 * 60 * 1000 ||
		typeof sources.title !== "string" ||
		typeof sources.captionsEnabled !== "boolean"
	) {
		throw new Error("Editor browser sources are invalid");
	}
	const display = signedVideo(sources.display, expiresAt);
	if (!display) throw new Error("Editor display video is unavailable");
	const displayMeta = record(sources.display);
	if (!validFps(displayMeta?.fps)) {
		throw new Error("Editor display timing is invalid");
	}
	const camera =
		sources.camera === undefined || sources.camera === null
			? null
			: signedVideo(sources.camera, expiresAt);
	if (sources.camera && !camera) {
		throw new Error("Editor camera video is unavailable");
	}
	const cameraMeta = record(sources.camera);
	if (
		camera &&
		(!validFps(cameraMeta?.fps) || !validOffset(cameraMeta?.offsetMs))
	) {
		throw new Error("Editor camera timing is invalid");
	}
	const mic = signedAudio(sources.mic, expiresAt);
	const systemAudio = signedAudio(sources.systemAudio, expiresAt);
	const micOffsetMs = mic?.offsetMs ?? null;
	const systemAudioOffsetMs = systemAudio?.offsetMs ?? null;
	const assets = new Map<string, BrowserVideoSource>();
	if (sources.videoAssets !== undefined) {
		if (!Array.isArray(sources.videoAssets)) {
			throw new Error("Editor clip sources are invalid");
		}
		for (const entry of sources.videoAssets) {
			const asset = record(entry);
			const video = signedVideo(asset, expiresAt);
			if (!asset || typeof asset.path !== "string" || !video) {
				throw new Error("Editor clip sources are invalid");
			}
			assets.set(asset.path, video);
		}
	}
	const segments: BrowserSourceSegment[] = [
		{
			display,
			camera,
			displayFps: displayMeta.fps,
			cameraFps: camera ? (cameraMeta?.fps as number) : null,
			cameraOffsetMs: camera ? (cameraMeta?.offsetMs as number) : null,
			micOffsetMs,
			systemAudioOffsetMs,
			duration: null,
			hasAudio: micOffsetMs !== null || systemAudioOffsetMs !== null,
		},
	];
	if (sources.imports !== undefined) {
		if (!Array.isArray(sources.imports)) {
			throw new Error("Editor imports are invalid");
		}
		for (const entry of sources.imports) {
			const item = record(entry);
			if (item?.kind === "clip") {
				segments.push(clipSegment(item.clip, assets));
			} else if (
				item?.kind === "cap" &&
				typeof item.clipCount === "number" &&
				Number.isSafeInteger(item.clipCount) &&
				item.clipCount > 0 &&
				item.clipCount <= 1000
			) {
				for (let index = 0; index < item.clipCount; index++) {
					segments.push({
						display: null,
						camera: null,
						displayFps: null,
						cameraFps: null,
						cameraOffsetMs: null,
						micOffsetMs: null,
						systemAudioOffsetMs: null,
						duration: null,
						hasAudio: false,
					});
				}
			} else {
				throw new Error("Editor imports are invalid");
			}
			if (segments.length > 1001) throw new Error("Editor has too many clips");
		}
	} else if (sources.clips !== undefined) {
		if (!Array.isArray(sources.clips)) {
			throw new Error("Editor clips are invalid");
		}
		for (const clip of sources.clips) {
			segments.push(clipSegment(clip, assets));
		}
	}
	return {
		videoId: expectedVideoId,
		title: sources.title,
		captionsEnabled: sources.captionsEnabled,
		projectConfig: sources.projectConfig ?? null,
		defaultStyle: parseDefaultStyle(sources.defaultStyle),
		displayHasAudio: sources.displayHasAudio === true,
		mic,
		systemAudio,
		inputEvents: signedInputEvents(sources.inputEvents, expiresAt),
		segments,
		expiresAt,
	};
}

function canceled(signal: AbortSignal) {
	return signal.reason instanceof Error
		? signal.reason
		: new DOMException("Canceled", "AbortError");
}

function waitWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(canceled(signal));
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(canceled(signal));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

type SharedSourceRequest = {
	promise: Promise<BrowserEditorSources>;
	expiresAt: number;
	prefetched: boolean;
	settled: boolean;
};

const sharedSourceRequests = new Map<string, SharedSourceRequest>();
const PREFETCH_TTL_MS = 60_000;
const SHARED_TTL_MS = 3000;

function sharedSourceRequest(videoId: string, prefetch = false) {
	const cached = sharedSourceRequests.get(videoId);
	if (cached && cached.expiresAt > Date.now()) {
		if (!prefetch && cached.prefetched) {
			cached.prefetched = false;
			if (cached.settled) {
				cached.expiresAt = Math.min(
					cached.expiresAt,
					Date.now() + SHARED_TTL_MS,
				);
			}
		}
		return cached.promise;
	}
	const entry: SharedSourceRequest = {
		promise: fetch(
			`/api/editor/videos/${encodeURIComponent(videoId)}/bootstrap`,
			{ credentials: "same-origin", cache: "no-store" },
		)
			.then(async (response) => {
				if (!response.ok)
					throw new Error("Editor browser sources are unavailable");
				const body: unknown = await response.json();
				return parseBrowserEditorSources(body, videoId);
			})
			.then(
				(value) => {
					if (sharedSourceRequests.get(videoId) === entry) {
						entry.settled = true;
						const ttl = entry.prefetched ? PREFETCH_TTL_MS : SHARED_TTL_MS;
						entry.expiresAt = Date.now() + ttl;
						globalThis.setTimeout(() => {
							if (
								sharedSourceRequests.get(videoId) === entry &&
								entry.expiresAt <= Date.now()
							)
								sharedSourceRequests.delete(videoId);
						}, ttl);
					}
					return value;
				},
				(error: unknown) => {
					if (sharedSourceRequests.get(videoId) === entry)
						sharedSourceRequests.delete(videoId);
					throw error;
				},
			),
		expiresAt: Number.POSITIVE_INFINITY,
		prefetched: prefetch,
		settled: false,
	};
	sharedSourceRequests.set(videoId, entry);
	return entry.promise;
}

/// Starts loading the recording's sources while the editor UI is still
/// booting; the first catalog snapshot picks the request up.
export function prefetchBrowserEditorSources(videoId: string) {
	return sharedSourceRequest(videoId, true);
}

export class BrowserEditorSourceCatalog {
	private readonly controller = new AbortController();
	private current: BrowserEditorSources | null = null;
	private pending: Promise<BrowserEditorSources> | null = null;

	constructor(private readonly videoId: string) {}

	private async load() {
		return waitWithAbort(
			sharedSourceRequest(this.videoId),
			this.controller.signal,
		);
	}

	async snapshot(signal: AbortSignal): Promise<BrowserEditorSources> {
		if (this.controller.signal.aborted) {
			throw new Error("Editor browser sources are closed");
		}
		if (this.current && this.current.expiresAt > Date.now() + 60_000) {
			return this.current;
		}
		if (!this.pending) {
			const pending = this.load();
			this.pending = pending;
			pending.then(
				(value) => {
					if (this.pending === pending) {
						this.current = value;
						this.pending = null;
					}
				},
				() => {
					if (this.pending === pending) this.pending = null;
				},
			);
		}
		return waitWithAbort(this.pending, signal);
	}

	readonly sourceProvider: BrowserVideoSourceProvider = async (
		segmentIndex: number,
		track: BrowserVideoTrack,
		signal: AbortSignal,
	) => {
		const snapshot = await this.snapshot(signal);
		const segment = snapshot.segments[segmentIndex];
		if (!segment) throw new Error("Editor clip is unavailable");
		return segment[track];
	};

	invalidate() {
		this.current = null;
		sharedSourceRequests.delete(this.videoId);
	}

	dispose() {
		this.controller.abort();
		this.current = null;
		this.pending = null;
	}
}
