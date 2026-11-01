import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { durableJson, readJson, sha256 } from "./checkpoint-store.mjs";

const execute = promisify(execFile);
const local = new URL("./src/transcribe.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);

const { glossaryTerms, resolveGlossaries } = await import(
	new URL("glossary.mjs", engine)
);

// The engine reads the key before it builds a request, so this error proves nothing was sent.
export const MISSING_KEY = /^no \S+ key\b/;
const KEY_RECHECK_MS = 30000;

export class CheckpointJobs {
	constructor(
		store,
		cfg,
		{ words, materialize, timeoutMs = 120000, media = execute, hasKey } = {},
	) {
		this.store = store;
		this.cfg = cfg;
		this.words = words;
		this.materialize = materialize ?? ((job) => this.audio(job));
		this.timeoutMs = timeoutMs;
		this.media = media;
		this.hasKey =
			hasKey ??
			(words
				? () => true
				: async () =>
						(
							await import(new URL("transcribe.mjs", engine))
						).providerKeyPresent(cfg));
		this.running = null;
		this.requeuedNotSent = false;
		this.nextKeyCheckAt = 0;
		for (const job of this.all())
			if (job.state === "ambiguous" && MISSING_KEY.test(job.error ?? ""))
				durableJson(this.jobPath(job.jobId), {
					...job,
					state: "failed",
					notSent: "missing-key",
				});
			else if (job.state === "submitted") {
				const result = this.resultPath(job.jobId);
				let recovered = null;
				try {
					recovered = fs.existsSync(result) ? readJson(result) : null;
				} catch {}
				durableJson(this.jobPath(job.jobId), {
					...job,
					state:
						recovered?.jobId === job.jobId && Array.isArray(recovered.words)
							? "complete"
							: "ambiguous",
					...(recovered
						? { resultHash: sha256(fs.readFileSync(result)) }
						: {
								error:
									"The provider may have accepted this job before the recorder stopped. Retry explicitly to allow another billable submission.",
							}),
				});
			}
	}
	jobPath(id) {
		if (!/^[a-f0-9]{64}$/.test(id))
			throw new Error("Invalid transcription job identity");
		return path.join(this.store.root, "jobs", `${id}.json`);
	}
	resultPath(id) {
		return path.join(this.store.root, "jobs", `${id}.words.json`);
	}
	read(id) {
		return readJson(this.jobPath(id));
	}
	all() {
		return fs
			.readdirSync(path.join(this.store.root, "jobs"))
			.filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
			.map((file) => readJson(path.join(this.store.root, "jobs", file)))
			.sort(
				(left, right) =>
					left.source.localeCompare(right.source) ||
					left.sourceStartMs - right.sourceStartMs,
			);
	}
	prepare(source, references, startMs, endMs, { tail = false } = {}) {
		if (!/^[\w:.-]{1,128}$/.test(source) || !(endMs > startMs) || startMs < 0)
			throw new Error("Invalid source transcription range");
		const options = this.options();
		const optionsHash = sha256(Buffer.from(JSON.stringify(options)));
		const identity = {
			source,
			sourceStartMs: startMs,
			sourceEndMs: endMs,
			contextStartMs: Math.max(0, startMs - 2000),
			optionsHash,
			generation: this.store.options.generation,
			tail,
		};
		const jobId = sha256(
			Buffer.from(
				JSON.stringify({
					...identity,
					references: references.map((reference) => reference.sha256),
				}),
			),
		);
		if (fs.existsSync(this.jobPath(jobId))) return this.read(jobId);
		const job = {
			schemaVersion: 1,
			jobId,
			...identity,
			...options,
			references,
			state: "prepared",
		};
		durableJson(this.jobPath(jobId), job);
		return job;
	}
	options() {
		return {
			provider: this.cfg.transcriber,
			model:
				this.cfg.transcriber === "assemblyai"
					? (this.cfg.assemblyaiModel ?? "universal-3-5-pro")
					: (this.cfg.elevenlabsModel ?? "scribe_v2"),
			language: this.cfg.language ?? "en",
			glossary: this.cfg.glossary ?? "",
			terms: glossaryTerms(resolveGlossaries(this.cfg.glossary)),
		};
	}
	requeue({ notSent: _notSent, error, ...job }) {
		durableJson(this.jobPath(job.jobId), {
			...job,
			state: "prepared",
			priorError: error,
		});
	}
	notSent(reason) {
		return this.all().filter(
			(job) =>
				job.state === "failed" &&
				job.notSent &&
				(!reason || job.notSent === reason),
		);
	}
	retry(id) {
		if (this.running)
			throw new Error(
				"Wait for the active transcription request before retrying",
			);
		const job = this.read(id);
		if (!["failed", "ambiguous"].includes(job.state))
			throw new Error(
				"Only failed or ambiguous jobs can be explicitly retried",
			);
		if (job.notSent) {
			this.requeue(job);
			return;
		}
		if ((job.manualRetries ?? 0) >= 3)
			throw new Error(
				"This job reached its three manual retry limit; retained source audio can be processed separately",
			);
		durableJson(this.jobPath(id), {
			...job,
			state: "prepared",
			manualRetries: (job.manualRetries ?? 0) + 1,
			retryAcknowledgedAt: Date.now(),
			priorError: job.error,
		});
	}
	async audio(job) {
		const output = path.join(this.store.root, "jobs", `${job.jobId}.wav`);
		if (fs.existsSync(output)) return output;
		const references = job.references
			.filter(
				(reference) =>
					reference.sourceEndMs > job.contextStartMs &&
					reference.sourceStartMs < job.sourceEndMs,
			)
			.sort((left, right) => left.sourceStartMs - right.sourceStartMs);
		if (!references.length)
			throw new Error("No durable audio covers this transcription job");
		const args = ["-v", "error", "-nostdin", "-y"];
		const filters = [];
		const labels = [];
		let cursor = job.contextStartMs;
		let input = 0;
		const silence = (duration) => {
			if (duration <= 0) return;
			const label = `gap${labels.length}`;
			filters.push(
				`anullsrc=r=16000:cl=mono,atrim=duration=${duration / 1000}[${label}]`,
			);
			labels.push(`[${label}]`);
		};
		for (const reference of references) {
			this.store.verify(reference);
			const start = Math.max(cursor, reference.sourceStartMs);
			const end = Math.min(job.sourceEndMs, reference.sourceEndMs);
			if (end <= start) continue;
			silence(start - cursor);
			args.push("-i", this.store.objectPath(reference.sha256));
			const label = `part${input}`;
			filters.push(
				`[${input++}:a:0]aresample=16000:async=1:first_pts=0,aformat=channel_layouts=mono,atrim=start=${(start - reference.sourceStartMs) / 1000}:end=${(end - reference.sourceStartMs) / 1000},asetpts=PTS-STARTPTS,apad,atrim=duration=${(end - start) / 1000}[${label}]`,
			);
			labels.push(`[${label}]`);
			cursor = end;
		}
		silence(job.sourceEndMs - cursor);
		filters.push(`${labels.join("")}concat=n=${labels.length}:v=0:a=1[out]`);
		const temporary = `${output}.tmp.wav`;
		try {
			await this.media(
				"ffmpeg",
				[
					...args,
					"-filter_complex_threads",
					"1",
					"-filter_complex",
					filters.join(";"),
					"-map",
					"[out]",
					"-c:a",
					"pcm_s16le",
					"-threads",
					"1",
					temporary,
				],
				{ timeout: 60000 },
			);
			const fd = fs.openSync(temporary, "r");
			try {
				fs.fsyncSync(fd);
			} finally {
				fs.closeSync(fd);
			}
			fs.renameSync(temporary, output);
			const { syncDirectory } = await import("./checkpoint-store.mjs");
			syncDirectory(path.dirname(output));
		} finally {
			fs.rmSync(temporary, { force: true });
		}
		return output;
	}
	cancel() {
		this.controller?.abort(
			new Error(
				"Recording stopped before this request was acknowledged; its result may be ambiguous",
			),
		);
	}
	async runNext() {
		if (fs.existsSync(path.join(this.store.root, "full-transcript.json")))
			return;
		if (this.running) return this.running;
		if (
			this.cfg.transcriber === "none" ||
			this.cfg.liveTranscription === false ||
			!["elevenlabs", "assemblyai"].includes(this.cfg.transcriber)
		)
			return;
		if (!this.requeuedNotSent) {
			this.requeuedNotSent = true;
			for (const job of this.notSent()) this.requeue(job);
		}
		const keyCheckDue =
			Date.now() >= this.nextKeyCheckAt &&
			this.notSent("missing-key").length > 0;
		if (!keyCheckDue && !this.all().some((item) => item.state === "prepared"))
			return;
		this.running = (async () => {
			this.nextKeyCheckAt = Date.now() + KEY_RECHECK_MS;
			const keyed = await this.hasKey();
			if (keyed)
				for (const job of this.notSent("missing-key")) this.requeue(job);
			const job = this.all().find((item) => item.state === "prepared");
			if (!job) return;
			if (!keyed) {
				durableJson(this.jobPath(job.jobId), {
					...job,
					state: "failed",
					notSent: "missing-key",
					error:
						"No provider key is available, so no request was sent. Add the key in Settings, then choose Resume evidence sync.",
				});
				return;
			}
			let submitted = false;
			try {
				if (
					job.optionsHash !==
					sha256(Buffer.from(JSON.stringify(this.options())))
				)
					throw new Error(
						"Prepared job options differ from current provider, model, language or glossary configuration; restore the original settings or explicitly process retained source separately",
					);
				const audio = await this.materialize(job);
				const terms = job.terms;
				durableJson(this.jobPath(job.jobId), {
					...job,
					state: "submitted",
					submittedAt: Date.now(),
				});
				submitted = true;
				this.controller = new AbortController();
				const words = await (
					this.words ??
					(await import(new URL("transcribe.mjs", engine))).transcribeWords
				)(audio, this.cfg, {
					terms,
					signal: AbortSignal.any([
						AbortSignal.timeout(this.timeoutMs),
						this.controller.signal,
					]),
					log: () => {},
				});
				if (
					!Array.isArray(words) ||
					words.some(
						(word) =>
							!Number.isFinite(word.start) ||
							!Number.isFinite(word.end) ||
							word.end < word.start ||
							typeof word.text !== "string",
					)
				)
					throw new Error("Provider returned invalid normalized words");
				const normalized = words
					.map((word) => ({
						...word,
						start: word.start + job.contextStartMs / 1000,
						end: word.end + job.contextStartMs / 1000,
						speaker: `${job.source}:${job.jobId.slice(0, 12)}:${word.speaker ?? "unknown"}`,
					}))
					.filter(
						(word) =>
							(word.start + word.end) * 500 >= job.sourceStartMs &&
							(word.start + word.end) * 500 < job.sourceEndMs,
					);
				const result = {
					schemaVersion: 1,
					jobId: job.jobId,
					source: job.source,
					provider: job.provider,
					model: job.model,
					optionsHash: job.optionsHash,
					sourceStartMs: job.sourceStartMs,
					sourceEndMs: job.sourceEndMs,
					contextStartMs: job.contextStartMs,
					speakerScope:
						"source and chunk; identities are not matched across requests",
					words: normalized,
					completedAt: Date.now(),
				};
				durableJson(this.resultPath(job.jobId), result);
				durableJson(this.jobPath(job.jobId), {
					...job,
					state: "complete",
					resultHash: sha256(fs.readFileSync(this.resultPath(job.jobId))),
				});
			} catch (error) {
				const missingKey = MISSING_KEY.test(error.message);
				const rejected =
					/\b4\d\d\b/.test(error.message) &&
					!/\b408\b|\b429\b/.test(error.message);
				durableJson(this.jobPath(job.jobId), {
					...job,
					state: submitted && !missingKey && !rejected ? "ambiguous" : "failed",
					...(missingKey
						? { notSent: "missing-key" }
						: submitted
							? {}
							: { notSent: "local" }),
					error: String(error.message).slice(0, 500),
				});
			}
		})().finally(() => {
			this.running = null;
			this.controller = null;
		});
		return this.running;
	}
}
