import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CheckpointJobs } from "./checkpoint-jobs.mjs";
import {
	CheckpointStore,
	completeJsonlPrefix,
	durableJson,
	MAX_OBJECT_BYTES,
	readJson,
	sha256,
} from "./checkpoint-store.mjs";
import { scanFragmentedAudio } from "./fragmented-audio.mjs";
import { sourceAudioProblem } from "./native-audio.mjs";
import { RecoveryTransport } from "./recovery-transport.mjs";
import { acquireWalkLock } from "./walk-lock.mjs";

const local = new URL("./src/config.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);
const execute = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DRAIN_MS = 150000;

export class CheckpointWorker {
	constructor(file, cfg, settings, dependencies = {}) {
		this.file = fs.realpathSync(file);
		this.directory = path.dirname(this.file);
		this.journal = readJson(file);
		if (fs.realpathSync(this.journal.request.directory) !== this.directory)
			throw new Error("Checkpoint journal belongs to another walk directory");
		this.cfg = cfg;
		this.settings = settings;
		const identityPath = path.join(this.directory, "checkpoints/identity.json");
		const identity = fs.existsSync(identityPath)
			? readJson(identityPath)
			: {
					recordingId: randomUUID(),
					generation: randomUUID(),
					endpoint: settings.server || "",
					backupEnabled: settings.backupEnabled === true,
					expiresInDays: settings.expiresInDays ?? 7,
					sessionGeneration: dependencies.sessionGeneration ?? 0,
				};
		this.store = new CheckpointStore(this.directory, identity);
		this.transport =
			dependencies.transport ?? new RecoveryTransport(identity.endpoint);
		this.nextUploadAt = 0;
		this.finalized = false;
		this.mediaTail = Promise.resolve();
		this.media = (...args) => {
			const next = this.mediaTail.then(() => execute(...args));
			this.mediaTail = next.catch(() => {});
			return next;
		};
		this.jobs = new CheckpointJobs(this.store, cfg, {
			media: this.media,
			...dependencies.jobs,
		});
		this.sources = {};
		this.fileCursors = {};
		this.transcriptObjects = new Set();
		this.remoteSources = {};
		for (const descriptor of this.store.descriptors()) {
			Object.assign(this.fileCursors, descriptor.fileCursors ?? {});
			Object.assign(this.sources, descriptor.sources ?? {});
			this.finalized = descriptor.finalized === true;
			for (const object of descriptor.objects.filter(
				(object) => object.kind === "transcriptWords",
			))
				this.transcriptObjects.add(object.sha256);
			if (descriptor.sequence <= this.store.state.remoteSequence)
				for (const object of descriptor.objects.filter((object) =>
					["microphone", "systemAudio"].includes(object.kind),
				))
					this.remoteSources[object.source] = Math.max(
						this.remoteSources[object.source] ?? 0,
						object.sourceEndMs ?? 0,
					);
		}
		this.uploading = null;
		this.lastCheckpointAt = 0;
		this.lastHeartBeat = null;
		this.phase = "recording";
		this.error = null;
		this.sourceErrors = {};
	}
	heartbeat() {
		const heartbeat = readJson(
			path.join(this.directory, "checkpoint-heartbeat.json"),
		);
		if (
			!Number.isSafeInteger(heartbeat.activeElapsedMs) ||
			heartbeat.activeElapsedMs < 0 ||
			!Number.isSafeInteger(heartbeat.wallMs) ||
			heartbeat.wallMs < 0 ||
			!Number.isSafeInteger(heartbeat.parentPid) ||
			heartbeat.parentPid < 1 ||
			typeof heartbeat.paused !== "boolean" ||
			(this.store.options.sessionGeneration &&
				heartbeat.generation !== this.store.options.sessionGeneration)
		)
			throw new Error(
				"Checkpoint heartbeat identity or active clock is invalid",
			);
		return heartbeat;
	}
	// Recorders that clear their session clock before the terminal heartbeat left walks with a
	// file below the saved clock, and Resume reads that same file. A live regression stays an error.
	settledClock(heartbeat) {
		if (this.journal.state === "recording" && heartbeat.captureEnded !== true)
			return heartbeat;
		return {
			...heartbeat,
			activeElapsedMs: Math.max(
				heartbeat.activeElapsedMs,
				this.journal.durationMs ?? 0,
				this.store.state.localClockThroughMs,
			),
		};
	}
	status(heartbeat = this.lastHeartBeat) {
		const sources = Object.fromEntries(
			Object.entries(this.sources).map(([source, state]) => {
				const completed = this.jobs
					.all()
					.filter((job) => job.source === source && job.state === "complete");
				let transcribed = 0;
				for (const job of completed.sort(
					(left, right) => left.sourceStartMs - right.sourceStartMs,
				)) {
					if (job.sourceStartMs > transcribed + 1) break;
					transcribed = Math.max(transcribed, job.sourceEndMs);
				}
				return [
					source,
					{
						durableSourceMs: state.sourceEndMs,
						remoteSourceMs: this.remoteSources[source] ?? 0,
						transcribedSourceMs: transcribed,
						alignment:
							"Source-local clock; global alignment is provisional until capture finalizes",
						unsupported: this.sourceErrors[source],
					},
				];
			}),
		);
		const supported =
			["elevenlabs", "assemblyai"].includes(this.cfg.transcriber) &&
			this.cfg.liveTranscription !== false;
		const jobs = this.jobs.all();
		const pendingAudio = Object.values(sources).some(
			(source) => source.durableSourceMs - source.transcribedSourceMs > 100,
		);
		const eventsFile = path.join(this.directory, "browser-evidence.jsonl");
		const remoteDescriptor = this.store
			.descriptors()
			.find(
				(descriptor) => descriptor.sequence === this.store.state.remoteSequence,
			);
		const events = {
			readableBytes: fs.existsSync(eventsFile)
				? fs.statSync(eventsFile).size
				: 0,
			durableBytes: this.fileCursors["browser-evidence.jsonl"] ?? 0,
			remoteBytes:
				remoteDescriptor?.fileCursors?.["browser-evidence.jsonl"] ?? 0,
		};
		const waitingSources = Object.entries(heartbeat?.expectedAudio ?? {})
			.filter(
				([kind, expected]) =>
					expected &&
					!Object.values(this.sources).some((state) => state.kind === kind),
			)
			.map(([kind]) => kind);
		const status = {
			schemaVersion: 1,
			recordingId: this.store.options.recordingId,
			generation: this.store.options.generation,
			phase: this.phase,
			observedActiveMs: heartbeat?.activeElapsedMs ?? 0,
			localClockThroughMs: this.store.state.localClockThroughMs,
			remoteClockThroughMs: this.store.state.remoteClockThroughMs,
			backupEnabled: this.store.options.backupEnabled,
			backupServer: this.store.options.endpoint,
			pendingCheckpoints:
				this.store.state.sequence - this.store.state.remoteSequence,
			events,
			waitingSources,
			sources,
			sourceErrors: this.sourceErrors,
			transcription:
				this.cfg.transcriber === "none"
					? "disabled"
					: this.phase === "stopped" &&
							this.finalized &&
							!jobs.length &&
							!Object.keys(sources).length &&
							!Object.keys(this.sourceErrors).length &&
							heartbeat?.expectedAudio?.microphone === false &&
							heartbeat?.expectedAudio?.systemAudio === false
						? "unavailable: no audio was selected"
						: supported && !Object.keys(this.sourceErrors).length
							? jobs.some(
									(job) =>
										job.state === "failed" && job.notSent === "missing-key",
								)
								? "needs a provider key: add it in Settings, then choose Resume evidence sync"
								: jobs.some((job) =>
											["failed", "ambiguous"].includes(job.state),
										)
									? "needs attention"
									: jobs.some((job) => job.state !== "complete")
										? "working"
										: !jobs.length || pendingAudio
											? "waiting for a five-minute chunk or stop tail"
											: "caught up to saved source audio"
							: "after recording stops",
			error: this.error,
			updatedAt: Date.now(),
		};
		durableJson(path.join(this.directory, "checkpoint-status.json"), status);
		return status;
	}
	scanSources(objects) {
		const root = path.join(this.journal.sourceProject, "content/segments");
		if (!fs.existsSync(root)) return;
		for (const name of fs
			.readdirSync(root)
			.filter((name) => /^segment-\d+$/.test(name))
			.sort((left, right) => Number(left.slice(8)) - Number(right.slice(8)))) {
			const directory = path.join(root, name);
			const timingFile = path.join(directory, "start-times.json");
			let timing = null;
			try {
				timing = readJson(timingFile);
			} catch {}
			for (const [filename, kind] of [
				["audio-input", "microphone"],
				["system_audio", "systemAudio"],
			]) {
				const source = `${name}:${kind}`;
				const file = path.join(directory, `${filename}.m4a`);
				if (!fs.existsSync(file)) {
					if (fs.existsSync(path.join(directory, `${filename}.ogg`)))
						this.sourceErrors[source] =
							"Live Ogg audio is not supported; source recording remains the stop-time transcription fallback";
					continue;
				}
				const previous = this.sources[source];
				const stat = fs.statSync(file);
				if (previous?.finalized) continue;
				if (
					previous &&
					(previous.inode !== stat.ino || stat.size < previous.cursor)
				) {
					this.sourceErrors[source] =
						"Audio finalized to another container; retained source-local checkpoints require final-tail reconciliation";
					continue;
				}
				let init = previous?.initHash
					? fs.readFileSync(this.store.objectPath(previous.initHash))
					: undefined;
				try {
					const scanned = scanFragmentedAudio(file, {
						cursor: previous?.cursor ?? 0,
						init,
						maxBytes: MAX_OBJECT_BYTES - 65536,
					});
					init = scanned.init;
					if (!scanned.fragments.length) continue;
					const body = Buffer.concat([
						init,
						...scanned.fragments.map((fragment) => fragment.bytes),
					]);
					const first = scanned.fragments[0];
					const last = scanned.fragments.at(-1);
					const initObject = this.store.put(
						kind === "microphone" ? "microphoneInit" : "systemAudioInit",
						init,
						{ activeStartMs: 0, activeEndMs: 0, source },
					);
					const reference = this.store.put(kind, body, {
						source,
						encoding: "fragmented",
						headerSize: init.length,
						initHash: initObject.sha256,
						byteStart: first.start,
						byteEnd: last.end,
						sourceStartMs: first.startMs,
						sourceEndMs: last.endMs,
						startTick: first.startTick,
						endTick: last.endTick,
						timescale: first.timescale,
						activeStartMs: 0,
						activeEndMs: 0,
					});
					objects.push(initObject, reference);
					this.sources[source] = {
						cursor: scanned.end,
						inode: stat.ino,
						initHash: initObject.sha256,
						sourceEndMs: last.endMs,
						timing,
						filename,
						kind,
						segment: name,
						sourceProject: this.journal.sourceProject,
					};
					delete this.sourceErrors[source];
				} catch (error) {
					this.sourceErrors[source] = String(error.message).slice(0, 300);
				}
			}
		}
	}
	async checkpoint({ force = false } = {}) {
		const observed = this.heartbeat();
		this.lastHeartBeat = observed;
		if (!force && Date.now() - this.lastCheckpointAt < 10000) {
			this.status(observed);
			return;
		}
		const objects = [];
		const proposedCursors = { ...this.fileCursors };
		this.journal = readJson(this.file);
		const heartbeat = this.settledClock(observed);
		this.lastHeartBeat = heartbeat;
		objects.push(
			this.store.put("journal", fs.readFileSync(this.file), {
				activeStartMs: 0,
				activeEndMs: heartbeat.activeElapsedMs,
			}),
		);
		for (const name of ["browser-evidence.jsonl"]) {
			const file = path.join(this.directory, name);
			if (!fs.existsSync(file)) continue;
			const start = this.fileCursors[name] ?? 0;
			const prefix = completeJsonlPrefix(file, start);
			if (prefix.bytes.length) {
				objects.push(
					this.store.put("events", prefix.bytes, {
						activeStartMs: 0,
						activeEndMs: heartbeat.activeElapsedMs,
						byteStart: start,
						byteEnd: prefix.end,
					}),
				);
				proposedCursors[name] = prefix.end;
			}
		}
		let browser = null;
		try {
			browser = readJson(path.join(this.directory, "browser-evidence.json"));
		} catch {}
		objects.push(
			this.store.put(
				"clock",
				Buffer.from(
					JSON.stringify({
						heartbeat,
						browser,
						sourceClocks: this.sources,
						noteDraft: heartbeat.noteDraft ?? "",
					}),
				),
				{ activeStartMs: 0, activeEndMs: heartbeat.activeElapsedMs },
			),
		);
		const beforeSources = structuredClone(this.sources);
		const beforeFinalized = this.finalized;
		this.scanSources(objects);
		if (this.journal.state === "complete" && !this.finalized)
			await this.finalizeSources(objects);
		for (const job of this.jobs
			.all()
			.filter((job) => job.state === "complete")) {
			const file = this.jobs.resultPath(job.jobId);
			const bytes = fs.readFileSync(file);
			if (sha256(bytes) !== job.resultHash) {
				this.error =
					"Saved transcript result failed its checksum; source audio remains retained";
				continue;
			}
			const hash = sha256(bytes);
			if (!this.transcriptObjects.has(hash))
				objects.push(
					this.store.put("transcriptWords", bytes, {
						source: job.source,
						sourceStartMs: job.sourceStartMs,
						sourceEndMs: job.sourceEndMs,
						activeStartMs: 0,
						activeEndMs: 0,
						jobId: job.jobId,
						provider: job.provider,
						model: job.model,
						optionsHash: job.optionsHash,
					}),
				);
		}
		const fullWords = path.join(this.store.root, "full-transcript-words.json");
		if (fs.existsSync(fullWords)) {
			const bytes = fs.readFileSync(fullWords);
			const receipt = readJson(
				path.join(this.store.root, "full-transcript.json"),
			);
			if (receipt.wordsHash !== sha256(bytes))
				this.error =
					"Full transcript metadata failed its integrity receipt; unverified bytes are excluded from backup";
			else if (!this.transcriptObjects.has(sha256(bytes)))
				objects.push(
					this.store.put("transcriptWords", bytes, {
						source: "exported-session",
						sourceStartMs: 0,
						sourceEndMs: this.journal.durationMs ?? heartbeat.activeElapsedMs,
						activeStartMs: 0,
						activeEndMs: 0,
					}),
				);
		}
		try {
			this.store.commit(
				objects,
				{
					wallMs: heartbeat.wallMs,
					activeElapsedMs: heartbeat.activeElapsedMs,
					paused: heartbeat.paused,
				},
				{
					fileCursors: proposedCursors,
					sources: this.sources,
					captureState: this.journal.state,
					finalized: this.finalized,
				},
			);
			this.fileCursors = proposedCursors;
			for (const object of objects.filter(
				(object) => object.kind === "transcriptWords",
			))
				this.transcriptObjects.add(object.sha256);
			this.lastCheckpointAt = Date.now();
		} catch (error) {
			this.sources = beforeSources;
			this.finalized = beforeFinalized;
			throw error;
		}
		this.prepareJobs(this.phase !== "recording");
		this.status(heartbeat);
	}
	async finalizeSources(objects) {
		const meta = readJson(
			path.join(this.journal.sourceProject, "recording-meta.json"),
		);
		if (!Array.isArray(meta.segments)) return;
		const configFile = path.join(
			this.journal.sourceProject,
			"project-config.json",
		);
		const config = fs.existsSync(configFile) ? readJson(configFile) : {};
		const displaySpans = [];
		const sourceDurations = {};
		for (const [index, segment] of meta.segments.entries()) {
			const segmentName = `segment-${index}`;
			const display = path.resolve(
				this.journal.sourceProject,
				segment.display.path,
			);
			const { stdout } = await execute(
				"ffprobe",
				[
					"-v",
					"error",
					"-show_entries",
					"format=duration",
					"-of",
					"json",
					display,
				],
				{ timeout: 10000 },
			);
			displaySpans.push(Number(JSON.parse(stdout).format?.duration));
			for (const [side, kind] of [
				["mic", "microphone"],
				["system_audio", "systemAudio"],
			]) {
				if (!segment[side]?.path) continue;
				const source = `${segmentName}:${kind}`;
				const file = path.resolve(
					this.journal.sourceProject,
					segment[side].path,
				);
				if (
					!file.startsWith(
						`${path.resolve(this.journal.sourceProject)}${path.sep}`,
					)
				)
					throw new Error("Final audio must stay in its owned recording");
				const { stdout } = await execute(
					"ffprobe",
					[
						"-v",
						"error",
						"-show_entries",
						"format=duration",
						"-of",
						"json",
						file,
					],
					{ timeout: 10000 },
				);
				const endMs = Number(JSON.parse(stdout).format?.duration) * 1000;
				if (!Number.isFinite(endMs) || endMs < 0)
					throw new Error("Final audio duration is invalid");
				sourceDurations[source] = endMs / 1000;
				let startMs = this.sources[source]?.sourceEndMs ?? 0;
				while (endMs - startMs > 1) {
					const finishMs = Math.min(endMs, startMs + 120000);
					const temporary = path.join(this.store.root, `tail-${kind}.wav`);
					try {
						await this.media(
							"ffmpeg",
							[
								"-v",
								"error",
								"-nostdin",
								"-y",
								"-ss",
								String(startMs / 1000),
								"-i",
								file,
								"-t",
								String((finishMs - startMs) / 1000),
								"-ac",
								"1",
								"-ar",
								"16000",
								"-c:a",
								"pcm_s16le",
								"-threads",
								"1",
								temporary,
							],
							{ timeout: 60000 },
						);
						objects.push(
							this.store.put(kind, fs.readFileSync(temporary), {
								source,
								encoding: "standalone",
								container: "wav",
								sourceStartMs: startMs,
								sourceEndMs: finishMs,
								activeStartMs: 0,
								activeEndMs: 0,
							}),
						);
					} finally {
						fs.rmSync(temporary, { force: true });
					}
					startMs = finishMs;
				}
				this.sources[source] = {
					...this.sources[source],
					sourceEndMs: endMs,
					segment: segmentName,
					kind,
					finalized: true,
				};
				delete this.sourceErrors[source];
			}
		}
		const layout = {
			schemaVersion: 1,
			meta: {
				segments: meta.segments.map((segment) => ({
					display: segment.display,
					camera: segment.camera,
					mic: segment.mic,
					system_audio: segment.system_audio,
				})),
			},
			config: {
				audio: config.audio,
				clips: config.clips,
				timeline: {
					segments: config.timeline?.segments,
					transitions: config.timeline?.transitions,
					audioSegments: config.timeline?.audioSegments,
					textSegments: config.timeline?.textSegments,
				},
			},
			displaySpans,
			alignmentProblem: sourceAudioProblem(this.journal.sourceProject, config),
			sourceDurations,
		};
		durableJson(path.join(this.store.root, "final-layout.json"), layout);
		objects.push(
			this.store.put(
				"clock",
				Buffer.from(JSON.stringify({ finalLayout: layout })),
				{ activeStartMs: 0, activeEndMs: this.lastHeartBeat.activeElapsedMs },
			),
		);
		this.finalized = true;
	}
	prepareJobs(tail = false) {
		if (fs.existsSync(path.join(this.store.root, "full-transcript.json")))
			return;
		if (
			this.cfg.liveTranscription === false ||
			!["elevenlabs", "assemblyai"].includes(this.cfg.transcriber)
		)
			return;
		const configFile = path.join(
			this.journal.sourceProject,
			"project-config.json",
		);
		const config = fs.existsSync(configFile) ? readJson(configFile) : {};
		const unsupported = sourceAudioProblem(this.journal.sourceProject, config);
		if (unsupported) {
			this.sourceErrors.transcription = unsupported;
			return;
		}

		const references = this.store
			.descriptors()
			.flatMap((descriptor) =>
				descriptor.objects.filter((object) =>
					["microphone", "systemAudio"].includes(object.kind),
				),
			);
		for (const source of Object.keys(this.sources)) {
			if (
				(config.audio?.[
					source.endsWith(":microphone") ? "micVolumeDb" : "systemVolumeDb"
				] ?? 0) < -30
			)
				continue;
			const refs = references
				.filter((reference) => reference.source === source)
				.sort((left, right) => left.sourceStartMs - right.sourceStartMs);
			const end = refs.at(-1)?.sourceEndMs ?? 0;
			const closedSegment = Object.values(this.sources).some(
				(state) =>
					Number(state.segment?.slice(8)) >
					Number(this.sources[source].segment?.slice(8)),
			);
			let start = Math.max(
				0,
				...this.jobs
					.all()
					.filter((job) => job.source === source)
					.map((job) => job.sourceEndMs),
			);
			while (
				this.jobs.all().filter((job) => job.state === "prepared").length < 4 &&
				(end - start >= 300000 ||
					((tail || closedSegment) && end > start + 100))
			) {
				const finish = Math.min(end, start + 300000);
				const selected = refs.filter(
					(reference) =>
						reference.sourceEndMs > Math.max(0, start - 2000) &&
						reference.sourceStartMs < finish,
				);
				this.jobs.prepare(source, selected, start, finish, {
					tail: finish - start < 300000,
				});
				start = finish;
			}
		}
	}
	async uploadNext() {
		if (
			this.uploading ||
			Date.now() < this.nextUploadAt ||
			!this.store.options.backupEnabled
		)
			return this.uploading;
		this.uploading = (async () => {
			const withinBudget = () => {
				if (this.uploadDeadlineAt && Date.now() >= this.uploadDeadlineAt)
					throw new Error(
						"Private backup drain deadline reached; pending objects are retained for Resume evidence sync",
					);
			};
			withinBudget();
			const settings = await this.transport.status();
			if (
				!settings.backupEnabled ||
				settings.server !== this.store.options.endpoint
			)
				throw new Error(
					"Private backup is disabled or its server changed; pending evidence remains local",
				);
			const registration = {
				schemaVersion: 1,
				recordingId: this.store.options.recordingId,
				writerGeneration: this.store.options.generation,
				title: Array.from(this.journal.request.topic, (character) =>
					character.codePointAt(0) < 32 || character.codePointAt(0) === 127
						? " "
						: character,
				)
					.join("")
					.slice(0, 200),
				startedAtMs: this.journal.startedAtMs,
				expiresInDays: this.store.options.expiresInDays ?? 7,
			};
			const registrationPath = path.join(this.store.root, "registration.json");
			durableJson(registrationPath, registration);
			const base = `/api/v1/recovery/${registration.recordingId}`;
			const registered = await this.transport.request("PUT", base, {
				input: registrationPath,
			});
			if (
				registered.recordingId !== registration.recordingId ||
				registered.writerGeneration !== registration.writerGeneration ||
				registered.requestHash !==
					sha256(Buffer.from(JSON.stringify(registration))) ||
				!Number.isSafeInteger(registered.expiresAt) ||
				registered.expiresAt <= Date.now()
			)
				throw new Error(
					"Recovery registration acknowledgement identity is invalid",
				);
			const descriptor = this.store.pending()[0];
			if (!descriptor) return;
			for (const object of descriptor.objects) {
				withinBudget();
				this.store.verify(object);
				const receipt = await this.transport.request(
					"PUT",
					`${base}/objects/${object.sha256}`,
					{ input: this.store.objectPath(object.sha256) },
				);
				if (receipt.sha256 !== object.sha256 || receipt.size !== object.size)
					throw new Error(
						"Recovery object acknowledgement integrity is invalid",
					);
			}
			withinBudget();
			const checkpointReceipt = await this.transport.request(
				"PUT",
				`${base}/checkpoints/${descriptor.sequence}`,
				{
					input: path.join(
						this.store.root,
						"descriptors",
						`${String(descriptor.sequence).padStart(12, "0")}.json`,
					),
				},
			);
			const uploadedDescriptor = fs.readFileSync(
				path.join(
					this.store.root,
					"descriptors",
					`${String(descriptor.sequence).padStart(12, "0")}.json`,
				),
			);
			if (
				checkpointReceipt.acknowledged !== true ||
				checkpointReceipt.sequence !== descriptor.sequence ||
				checkpointReceipt.sha256 !== sha256(uploadedDescriptor)
			)
				throw new Error(
					"Recovery checkpoint acknowledgement receipt does not match uploaded data",
				);
			this.store.acknowledge(descriptor.sequence, this.store.options.endpoint);
			for (const object of descriptor.objects.filter((object) =>
				["microphone", "systemAudio"].includes(object.kind),
			))
				this.remoteSources[object.source] = Math.max(
					this.remoteSources[object.source] ?? 0,
					object.sourceEndMs,
				);
			this.error = null;
		})()
			.catch((error) => {
				this.error = String(error.message).slice(0, 500);
				this.nextUploadAt = Date.now() + 10000;
			})
			.finally(() => {
				this.uploading = null;
				this.status();
			});
		return this.uploading;
	}
}

export async function runCheckpointWorker(file, cfg, dependencies = {}) {
	const directory = path.dirname(fs.realpathSync(file));
	const lease = await acquireWalkLock(directory, "checkpoint");
	const drainMs = dependencies.drainMs ?? DRAIN_MS;
	let worker;
	try {
		const initial = readJson(path.join(directory, "checkpoint-heartbeat.json"));
		const transport = dependencies.transport ?? new RecoveryTransport("");
		const settings = await transport.status();
		worker = new CheckpointWorker(file, cfg, settings, {
			...dependencies,
			sessionGeneration: initial.generation,
			transport: dependencies.transport,
		});
		if (dependencies.retryJobId) worker.jobs.retry(dependencies.retryJobId);
		let terminalAt = null;
		let terminalSealed = false;
		let previousPaused = null;
		for (;;) {
			let heartbeat;
			try {
				heartbeat = worker.heartbeat();
				let parentAlive = true;
				try {
					process.kill(heartbeat.parentPid, 0);
				} catch {
					parentAlive = false;
				}
				const journal = readJson(file);
				let terminalStarted = false;
				if (journal.state !== "recording" || !parentAlive) {
					worker.phase =
						journal.state === "complete" ? "draining" : "interrupted";
					if (heartbeat.captureEnded !== false || !parentAlive) {
						terminalStarted = terminalAt == null;
						terminalAt ??= Date.now();
						// An explicit Resume must not abort a saved job at the deadline: that would
						// turn a job it just unblocked into an ambiguous, possibly billed one.
						if (dependencies.resume && worker.jobs.running)
							terminalAt = Date.now();
						worker.uploadDeadlineAt = terminalAt + drainMs;
					}
				}
				if (!terminalSealed)
					await worker.checkpoint({
						force:
							terminalStarted ||
							(previousPaused !== null && previousPaused !== heartbeat.paused),
					});
				previousPaused = heartbeat.paused;
				const outstandingJobs = () =>
					worker.jobs.running ||
					worker.jobs.all().some((job) => job.state === "prepared");
				if (
					!worker.jobs.running &&
					(terminalAt == null || Date.now() - terminalAt < drainMs)
				)
					void worker.jobs.runNext().catch((error) => {
						worker.error = error.message;
					});
				if (terminalAt != null && !outstandingJobs() && !terminalSealed) {
					await worker.checkpoint({ force: true });
					terminalSealed = !outstandingJobs();
				}
				if (
					!worker.uploading &&
					(terminalAt == null || Date.now() - terminalAt < drainMs)
				)
					void worker.uploadNext().catch((error) => {
						worker.error = String(error.message).slice(0, 500);
					});
				const pendingRemote =
					worker.store.options.backupEnabled &&
					worker.store.state.remoteSequence < worker.store.state.sequence;
				if (
					terminalAt != null &&
					((terminalSealed && !pendingRemote) ||
						Date.now() - terminalAt > drainMs)
				) {
					worker.jobs.cancel();
					if (worker.jobs.running) await worker.jobs.running;
					if (worker.uploading) await worker.uploading;
					if (!terminalSealed) await worker.checkpoint({ force: true });
					if (terminalSealed) {
						const sequence = worker.store.state.sequence;
						const descriptorFile = path.join(
							worker.store.root,
							"descriptors",
							`${String(sequence).padStart(12, "0")}.json`,
						);
						durableJson(path.join(worker.store.root, "seal.json"), {
							schemaVersion: 1,
							recordingId: worker.store.options.recordingId,
							generation: worker.store.options.generation,
							sequence,
							descriptorHash: sha256(fs.readFileSync(descriptorFile)),
							captureState: journal.state,
							providerJobs: worker.jobs.all().length,
							unsupportedSources: worker.sourceErrors,
							expectedAudio: worker.heartbeat().expectedAudio,
							sourceCaptureState: fs.existsSync(
								path.join(worker.journal.sourceProject, "recording-meta.json"),
							)
								? readJson(
										path.join(
											worker.journal.sourceProject,
											"recording-meta.json",
										),
									).status?.status
								: null,
							finalLayoutHash: fs.existsSync(
								path.join(worker.store.root, "final-layout.json"),
							)
								? sha256(
										fs.readFileSync(
											path.join(worker.store.root, "final-layout.json"),
										),
									)
								: null,
							sealedAt: Date.now(),
						});
					}
					worker.phase =
						journal.state === "complete" ? "stopped" : "interrupted";
					worker.status();
					break;
				}
			} catch (error) {
				worker.error = String(error.message).slice(0, 500);
				const drainFailed =
					terminalAt != null && Date.now() - terminalAt > drainMs;
				if (drainFailed) {
					worker.phase = "resume-needed";
					worker.error = `${worker.error} Saved source data is kept. Choose Resume evidence sync in saved notes to finish the remaining work.`;
				}
				worker.status(heartbeat);
				if (drainFailed) break;
				if (!heartbeat && Date.now() - (initial.wallMs ?? 0) > 150000) break;
			}
			await pause(1000);
		}
	} finally {
		try {
			if (worker) {
				worker.jobs.cancel();
				worker.uploadDeadlineAt = Date.now();
				await Promise.allSettled(
					[worker.jobs.running, worker.uploading].filter(Boolean),
				);
			}
		} finally {
			await lease.release();
		}
	}
	if (
		worker?.phase === "stopped" &&
		readJson(file).state === "complete" &&
		fs.existsSync(path.join(directory, "processing.json"))
	) {
		try {
			const reconcile =
				dependencies.reconcileReport ??
				(await import("./native-walk.mjs")).finishNativeWalk;
			await reconcile(file, cfg, {
				reconcileStopTail: true,
				reconcileWaitMs: dependencies.reconcileWaitMs,
			});
		} catch (error) {
			durableJson(path.join(directory, `report-refresh-${randomUUID()}.json`), {
				schemaVersion: 1,
				error: String(error.message).slice(0, 500),
				attemptedAt: Date.now(),
			});
		}
	}
}

if (
	process.argv[1] &&
	path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const { loadConfig } = await import(new URL("config.mjs", engine));
	const retryJobId =
		process.argv[3] === "--retry-job" ? process.argv[4] : undefined;
	const { withJournalProject } = await import("./walk-project.mjs");
	runCheckpointWorker(
		process.argv[2],
		withJournalProject(process.argv[2], loadConfig()),
		{
			retryJobId,
			resume: retryJobId !== undefined,
		},
	).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
