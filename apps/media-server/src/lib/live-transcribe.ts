import { z } from "zod";

/**
 * Live transcription sessions for instant-mode recordings. Cap's web app
 * starts one per recording (apps/web/lib/live-transcribe-farm.ts). The session
 * watches the segment manifest, transcribes new audio in chunks through the
 * AssemblyAI-compatible API it was given, and reports each chunk's words to
 * the web app, which owns the transcript artifact, the claim, and promotion.
 * Every report answers with the authoritative cursor and fresh signed URLs,
 * so this server holds no storage credentials and no transcript state of its
 * own: a lost session costs only the chunk in flight.
 */

export const LIVE = {
	INITIAL_CHUNK_SECONDS: 5,
	MAX_CHUNK_SECONDS: 10,
	GROW_AFTER_CHUNKS: 2,
	MAX_CHUNK_TAKE_SECONDS: 60,
	MAX_TRANSCRIBED_MS: 60 * 60 * 1000,
	MAX_CHUNKS: 420,
	/** The manifest is re-uploaded after every ~3 s segment. */
	POLL_INTERVAL_MS: 1_000,
	/** No new audio for this long ends the session (the workflow's 4 x 2 min). */
	MAX_IDLE_MS: 8 * 60 * 1000,
	/** Reports at least this often while idle keep the claim fresh (the web
	 * app treats a claim older than 3 minutes as dead) and the URLs signed. */
	SYNC_INTERVAL_MS: 60_000,
	MAX_SESSION_MS: 3 * 60 * 60 * 1000,
	MAX_CHUNK_ATTEMPTS: 2,
	MAX_SESSIONS: 200,
	ASR_POLL_INTERVAL_MS: 500,
	ASR_TIMEOUT_MS: 3 * 60 * 1000,
	DOWNLOAD_TIMEOUT_MS: 30_000,
	DOWNLOAD_CONCURRENCY: 8,
	MAX_CHUNK_BYTES: 64 * 1024 * 1024,
	REPORT_TIMEOUT_MS: 30_000,
	FINISH_TIMEOUT_MS: 110_000,
	/** A release only restarts the session elsewhere, so it must not hold up
	 * a server that is shutting down. */
	RELEASE_TIMEOUT_MS: 20_000,
	MAX_RELEASE_WAIT_MS: 45_000,
} as const;

const manifestEntrySchema = z.union([
	z.number(),
	z.object({ index: z.number(), duration: z.number() }),
]);

const manifestSchema = z.object({
	audio_init_uploaded: z.boolean(),
	audio_segments: z.array(manifestEntrySchema),
	is_complete: z.boolean(),
});

export type LiveManifest = z.infer<typeof manifestSchema>;

const stateSchema = z.object({
	lastAudioSegmentIndex: z.number().int(),
	transcribedDurationMs: z.number(),
	transcriptionOptions: z.record(z.unknown()),
	urls: z.object({
		manifest: z.string().url(),
		audioInit: z.string().url(),
		segments: z.record(z.string().url()),
	}),
});

export type LiveSessionState = z.infer<typeof stateSchema>;

export const startLiveSessionSchema = z.object({
	videoId: z.string().min(1).max(64),
	session: z.string().min(1).max(64),
	callbackUrl: z.string().url(),
	asr: z.object({
		baseUrl: z.string().url(),
		apiKey: z.string().min(1),
	}),
	contextSeconds: z.number().min(0).max(60),
	state: stateSchema,
});

export type StartLiveSession = z.infer<typeof startLiveSessionSchema>;

const reportAnswerSchema = z.union([
	z.object({ continue: z.literal(false) }),
	z.object({ continue: z.literal(true), state: stateSchema }),
]);

type Entry = { index: number; duration: number };

export type LiveChunkPlan =
	| { action: "wait" }
	| { action: "no-audio" }
	| { action: "done" }
	| { action: "need-urls" }
	| { action: "chunk"; entries: Entry[]; context: Entry[] };

/**
 * The web app's planNextLiveChunk (apps/web/lib/live-transcribe-core.ts),
 * limited to segments this session has URLs for. Only decides which segments
 * to send; the web app rebuilds the timing from the manifest itself and
 * rejects a chunk that doesn't start right after its cursor.
 */
export function planLiveChunk(options: {
	manifest: LiveManifest;
	lastProcessedIndex: number;
	targetSeconds: number;
	contextSeconds: number;
	hasUrl: (index: number) => boolean;
}): LiveChunkPlan {
	const { manifest, lastProcessedIndex, targetSeconds, hasUrl } = options;

	if (manifest.audio_segments.length === 0) {
		return manifest.is_complete ? { action: "no-audio" } : { action: "wait" };
	}
	if (!manifest.is_complete && !manifest.audio_init_uploaded) {
		return { action: "wait" };
	}

	const byIndex = new Map<number, Entry>();
	for (const raw of manifest.audio_segments) {
		const entry = typeof raw === "number" ? { index: raw, duration: 3 } : raw;
		if (
			!Number.isFinite(entry.index) ||
			entry.index < 0 ||
			!Number.isFinite(entry.duration) ||
			entry.duration < 0
		) {
			return { action: "wait" };
		}
		if (!byIndex.has(entry.index)) byIndex.set(entry.index, entry);
	}
	const sorted = [...byIndex.values()].sort((a, b) => a.index - b.index);

	const processed: Entry[] = [];
	const pending: Entry[] = [];
	let expectedIndex = sorted[0]?.index === 0 ? 0 : 1;
	for (const entry of sorted) {
		if (entry.index !== expectedIndex) break;
		expectedIndex++;
		if (entry.index <= lastProcessedIndex) processed.push(entry);
		else pending.push(entry);
	}

	if (pending.length === 0) {
		return manifest.is_complete ? { action: "done" } : { action: "wait" };
	}

	const entries: Entry[] = [];
	let takenSeconds = 0;
	for (const entry of pending) {
		if (!hasUrl(entry.index)) break;
		if (
			entries.length > 0 &&
			takenSeconds + entry.duration > LIVE.MAX_CHUNK_TAKE_SECONDS
		) {
			break;
		}
		entries.push(entry);
		takenSeconds += entry.duration;
		if (takenSeconds >= LIVE.MAX_CHUNK_TAKE_SECONDS) break;
	}
	if (entries.length === 0) return { action: "need-urls" };

	const tookEverything = entries.length === pending.length;
	if (!manifest.is_complete && tookEverything && takenSeconds < targetSeconds) {
		return { action: "wait" };
	}

	const context: Entry[] = [];
	let contextTaken = 0;
	for (let i = processed.length - 1; i >= 0; i--) {
		const entry = processed[i] as Entry;
		if (contextTaken >= options.contextSeconds || !hasUrl(entry.index)) break;
		context.unshift(entry);
		contextTaken += entry.duration;
	}

	return { action: "chunk", entries, context };
}

export function isNoSpokenAudioError(transcript: {
	status?: unknown;
	error?: unknown;
}) {
	return (
		transcript.status === "error" &&
		typeof transcript.error === "string" &&
		/no spoken audio/i.test(transcript.error)
	);
}

type AsrWord = {
	text: string;
	start: number;
	end: number;
	confidence: number | null;
	speaker: string | null;
};

type AsrResult = { words: AsrWord[]; languageCode: string | null };

function pickWords(words: unknown): AsrWord[] {
	if (!Array.isArray(words)) return [];
	const result: AsrWord[] = [];
	for (const word of words) {
		if (!word || typeof word !== "object") continue;
		const { text, start, end, confidence, speaker } = word as Record<
			string,
			unknown
		>;
		if (
			typeof text !== "string" ||
			typeof start !== "number" ||
			typeof end !== "number"
		) {
			continue;
		}
		result.push({
			text: text.slice(0, 200),
			start,
			end,
			confidence: typeof confidence === "number" ? confidence : null,
			speaker: typeof speaker === "string" ? speaker.slice(0, 40) : null,
		});
	}
	return result;
}

function sleep(ms: number, signal?: AbortSignal) {
	return new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const done = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal?.addEventListener("abort", done, { once: true });
	});
}

async function readJson(response: Response, what: string) {
	if (!response.ok) {
		const detail = (await response.text().catch(() => "")).slice(0, 200);
		throw new Error(`${what} failed: HTTP ${response.status} ${detail}`);
	}
	return (await response.json()) as Record<string, unknown>;
}

/** Upload, submit and wait, like the AssemblyAI SDK's transcripts.transcribe,
 * but polling every 500 ms instead of 3 s (Cap's own service answers the
 * submit with the finished transcript when it can). */
export async function transcribeAudio(options: {
	baseUrl: string;
	apiKey: string;
	audio: Uint8Array<ArrayBuffer>;
	transcriptionOptions: Record<string, unknown>;
	signal: AbortSignal;
}): Promise<AsrResult> {
	const base = options.baseUrl.replace(/\/+$/, "");
	const deadline = AbortSignal.timeout(LIVE.ASR_TIMEOUT_MS);
	const signal = AbortSignal.any([options.signal, deadline]);
	const headers = { Authorization: options.apiKey };

	const upload = await readJson(
		await fetch(`${base}/v2/upload`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/octet-stream" },
			body: options.audio,
			signal,
		}),
		"Transcription upload",
	);
	if (typeof upload.upload_url !== "string") {
		throw new Error("Transcription upload returned no upload_url");
	}

	let transcript = await readJson(
		await fetch(`${base}/v2/transcript`, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				...options.transcriptionOptions,
				audio_url: upload.upload_url,
			}),
			signal,
		}),
		"Transcription submit",
	);
	const id = transcript.id;
	if (typeof id !== "string" || !/^[\w-]+$/.test(id)) {
		throw new Error("Transcription submit returned no id");
	}

	while (transcript.status !== "completed" && transcript.status !== "error") {
		await sleep(LIVE.ASR_POLL_INTERVAL_MS, signal);
		if (signal.aborted) throw new Error("Transcription timed out");
		transcript = await readJson(
			await fetch(`${base}/v2/transcript/${id}`, { headers, signal }),
			"Transcription poll",
		);
	}

	if (transcript.status === "error") {
		if (isNoSpokenAudioError(transcript)) {
			return { words: [], languageCode: null };
		}
		throw new Error(
			`Transcription failed: ${String(transcript.error ?? "unknown error").slice(0, 200)}`,
		);
	}

	return {
		words: pickWords(transcript.words),
		languageCode:
			typeof transcript.language_code === "string"
				? transcript.language_code.slice(0, 16)
				: null,
	};
}

type ReportAnswer = "ok" | "stop" | "failed";

export type LiveSessionDeps = {
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	secret?: string;
};

export class LiveSession {
	readonly videoId: string;
	readonly session: string;
	private readonly request: StartLiveSession;
	private state: LiveSessionState;
	private readonly abort = new AbortController();
	private releasing = false;
	private manifest: { etag: string | null; value: LiveManifest } | null = null;
	private initAudio: Uint8Array | null = null;
	private readonly segmentCache = new Map<number, Uint8Array>();
	private lastReportAt: number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly secret: string | undefined;
	done: Promise<void> = Promise.resolve();

	constructor(request: StartLiveSession, deps: LiveSessionDeps = {}) {
		this.videoId = request.videoId;
		this.session = request.session;
		this.request = request;
		this.state = request.state;
		this.sleep = deps.sleep ?? sleep;
		this.secret = deps.secret ?? process.env.MEDIA_SERVER_WEBHOOK_SECRET;
		this.lastReportAt = Date.now();
	}

	start() {
		this.done = this.run();
		return this.done;
	}

	cancel() {
		this.abort.abort();
	}

	release() {
		this.releasing = true;
		this.abort.abort();
		return this.done;
	}

	private async run() {
		let outcome: string | null = null;
		try {
			outcome = await this.loop();
		} catch (error) {
			console.warn(
				`[live-transcribe] ${this.videoId} session failed:`,
				error instanceof Error ? error.message : String(error),
			);
			outcome = "session-error";
		}
		if (this.releasing) {
			await this.report(
				{ action: "release" },
				LIVE.RELEASE_TIMEOUT_MS,
				2,
				false,
			);
		} else if (outcome) {
			await this.report(
				{ action: "finish", outcome },
				LIVE.FINISH_TIMEOUT_MS,
				5,
				false,
			);
		}
		this.segmentCache.clear();
		this.initAudio = null;
	}

	private get signal() {
		return this.abort.signal;
	}

	private async loop(): Promise<string | null> {
		const now = Date.now;
		const startedAt = now();
		let lastProgressAt = startedAt;
		let chunkCount =
			this.state.lastAudioSegmentIndex >= 0 ? LIVE.GROW_AFTER_CHUNKS : 0;
		let failures = 0;

		while (!this.signal.aborted) {
			if (now() - startedAt > LIVE.MAX_SESSION_MS) return "session-limit";
			if (chunkCount >= LIVE.MAX_CHUNKS) return "chunk-limit";
			if (this.state.transcribedDurationMs >= LIVE.MAX_TRANSCRIBED_MS) {
				return "budget-exhausted";
			}

			const manifest = await this.readManifest();
			if (this.signal.aborted) break;
			const plan = manifest
				? planLiveChunk({
						manifest,
						lastProcessedIndex: this.state.lastAudioSegmentIndex,
						targetSeconds:
							chunkCount < LIVE.GROW_AFTER_CHUNKS
								? LIVE.INITIAL_CHUNK_SECONDS
								: LIVE.MAX_CHUNK_SECONDS,
						// A retry drops the context in case the earlier audio is
						// what fails.
						contextSeconds: failures === 0 ? this.request.contextSeconds : 0,
						hasUrl: (index) => String(index) in this.state.urls.segments,
					})
				: ({ action: "wait" } as const);

			if (plan.action === "done") return "done";
			if (plan.action === "no-audio") return "no-audio";

			if (plan.action === "wait" || plan.action === "need-urls") {
				if (now() - lastProgressAt > LIVE.MAX_IDLE_MS) return "stalled";
				const sinceReport = now() - this.lastReportAt;
				if (
					sinceReport >
					(plan.action === "need-urls"
						? LIVE.POLL_INTERVAL_MS * 5
						: LIVE.SYNC_INTERVAL_MS)
				) {
					const answer = await this.report({ action: "sync" });
					if (answer === "stop") return null;
				}
				await this.sleep(LIVE.POLL_INTERVAL_MS, this.signal);
				continue;
			}

			const cursor = this.state.lastAudioSegmentIndex;
			const range = `${plan.entries[0]?.index}..${plan.entries.at(-1)?.index}`;
			const lastIndex = plan.entries.at(-1)?.index ?? cursor;
			let report: Record<string, unknown>;
			if (failures >= LIVE.MAX_CHUNK_ATTEMPTS) {
				console.warn(
					`[live-transcribe] ${this.videoId} skipping chunk ${range}`,
				);
				report = { action: "gap", lastProcessedIndex: cursor, lastIndex };
			} else {
				try {
					const audio = await this.loadAudio([
						...plan.context,
						...plan.entries,
					]);
					const result = await transcribeAudio({
						baseUrl: this.request.asr.baseUrl,
						apiKey: this.request.asr.apiKey,
						audio,
						transcriptionOptions: this.state.transcriptionOptions,
						signal: this.signal,
					});
					report = {
						action: "chunk",
						lastProcessedIndex: cursor,
						lastIndex,
						contextFromIndex: plan.context[0]?.index ?? null,
						words: result.words,
						languageCode: result.languageCode,
					};
				} catch (error) {
					if (this.signal.aborted) break;
					console.warn(
						`[live-transcribe] ${this.videoId} chunk ${range} failed:`,
						error instanceof Error ? error.message : String(error),
					);
					failures++;
					if (failures >= LIVE.MAX_CHUNK_ATTEMPTS * 3) return "chunk-abandoned";
					continue;
				}
			}

			const answer = await this.report(report);
			if (answer === "stop") return null;
			if (answer === "ok" && this.state.lastAudioSegmentIndex > cursor) {
				failures = 0;
				chunkCount++;
				lastProgressAt = now();
				continue;
			}
			// Not accepted: the report failed, or the web app's cursor or
			// manifest disagree with this chunk. Retry, then skip, then give up.
			failures++;
			if (failures >= LIVE.MAX_CHUNK_ATTEMPTS * 3) return "chunk-abandoned";
			await this.sleep(LIVE.POLL_INTERVAL_MS, this.signal);
		}
		return null;
	}

	private async readManifest(): Promise<LiveManifest | null> {
		try {
			const response = await fetch(this.state.urls.manifest, {
				headers: this.manifest?.etag
					? { "If-None-Match": this.manifest.etag }
					: undefined,
				signal: AbortSignal.any([
					this.signal,
					AbortSignal.timeout(LIVE.DOWNLOAD_TIMEOUT_MS),
				]),
			});
			if (response.status === 304 && this.manifest) {
				return this.manifest.value;
			}
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				return null;
			}
			const parsed = manifestSchema.safeParse(await response.json());
			if (!parsed.success) return null;
			this.manifest = {
				etag: response.headers.get("etag"),
				value: parsed.data,
			};
			return parsed.data;
		} catch {
			return null;
		}
	}

	private async loadAudio(entries: Entry[]): Promise<Uint8Array<ArrayBuffer>> {
		const fetchBytes = async (url: string) => {
			const response = await fetch(url, {
				signal: AbortSignal.any([
					this.signal,
					AbortSignal.timeout(LIVE.DOWNLOAD_TIMEOUT_MS),
				]),
			});
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`Segment not accessible: HTTP ${response.status}`);
			}
			return new Uint8Array(await response.arrayBuffer());
		};

		this.initAudio ??= await fetchBytes(this.state.urls.audioInit);
		const missing = entries.filter(
			(entry) => !this.segmentCache.has(entry.index),
		);
		for (
			let start = 0;
			start < missing.length;
			start += LIVE.DOWNLOAD_CONCURRENCY
		) {
			const batch = missing.slice(start, start + LIVE.DOWNLOAD_CONCURRENCY);
			const buffers = await Promise.all(
				batch.map((entry) => {
					const url = this.state.urls.segments[String(entry.index)];
					if (!url) throw new Error(`No URL for segment ${entry.index}`);
					return fetchBytes(url);
				}),
			);
			for (const [offset, entry] of batch.entries()) {
				this.segmentCache.set(entry.index, buffers[offset] as Uint8Array);
			}
		}

		const parts = [
			this.initAudio,
			...entries.map((entry) => this.segmentCache.get(entry.index)),
		] as Uint8Array[];
		const size = parts.reduce((sum, part) => sum + part.byteLength, 0);
		if (size > LIVE.MAX_CHUNK_BYTES) {
			throw new Error(`Chunk audio exceeds ${LIVE.MAX_CHUNK_BYTES} bytes`);
		}
		const audio = new Uint8Array(size);
		let offset = 0;
		for (const part of parts) {
			audio.set(part, offset);
			offset += part.byteLength;
		}

		const keepFrom = (entries[entries.length - 1]?.index ?? 0) - 64;
		for (const index of this.segmentCache.keys()) {
			if (index < keepFrom) this.segmentCache.delete(index);
		}
		return audio;
	}

	/**
	 * Reports made from inside the loop stop as soon as the session is
	 * released or cancelled, so a slow chunk report can't delay the handoff.
	 * Abandoning one mid-flight is safe: the web app only applies a chunk that
	 * still matches its cursor and the artifact copy it read.
	 */
	private async report(
		body: Record<string, unknown>,
		timeoutMs: number = LIVE.REPORT_TIMEOUT_MS,
		attempts = 3,
		cancellable = true,
	): Promise<ReportAnswer> {
		const cancel = cancellable ? this.signal : undefined;
		for (let attempt = 0; attempt < attempts; attempt++) {
			if (attempt > 0) await this.sleep(1_000 * 2 ** (attempt - 1), cancel);
			if (cancel?.aborted) return "failed";
			try {
				const response = await fetch(this.request.callbackUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						...(this.secret ? { "x-media-server-secret": this.secret } : {}),
					},
					body: JSON.stringify({
						...body,
						videoId: this.videoId,
						session: this.session,
					}),
					signal: cancel
						? AbortSignal.any([cancel, AbortSignal.timeout(timeoutMs)])
						: AbortSignal.timeout(timeoutMs),
				});
				if (response.status >= 400 && response.status < 500) {
					await response.body?.cancel().catch(() => {});
					return "failed";
				}
				if (!response.ok) {
					await response.body?.cancel().catch(() => {});
					continue;
				}
				const answer = reportAnswerSchema.safeParse(await response.json());
				if (!answer.success) return "failed";
				this.lastReportAt = Date.now();
				if (!answer.data.continue) return "stop";
				this.state = answer.data.state;
				return "ok";
			} catch {}
		}
		return "failed";
	}
}

const sessions = new Map<string, LiveSession>();

export function getLiveSessionCount() {
	return sessions.size;
}

export function canAcceptLiveSession() {
	return sessions.size < LIVE.MAX_SESSIONS;
}

// An older session for the same recording was already fenced off by the web
// app when it rotated the claim, so it is cancelled without reporting.
export function startLiveSession(
	request: StartLiveSession,
	deps?: LiveSessionDeps,
): LiveSession {
	sessions.get(request.videoId)?.cancel();
	const session = new LiveSession(request, deps);
	sessions.set(request.videoId, session);
	void session.start().finally(() => {
		if (sessions.get(request.videoId) === session) {
			sessions.delete(request.videoId);
		}
	});
	return session;
}

let releasing: Promise<void> | null = null;

export function releaseLiveSessions(): Promise<void> {
	releasing ??= Promise.race([
		Promise.all([...sessions.values()].map((session) => session.release())),
		sleep(LIVE.MAX_RELEASE_WAIT_MS),
	]).then(() => {});
	return releasing;
}
