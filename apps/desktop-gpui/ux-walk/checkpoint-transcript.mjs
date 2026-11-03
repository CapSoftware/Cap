import fs from "node:fs";
import path from "node:path";
import {
	durableJson,
	durableWrite,
	readJson,
	sha256,
} from "./checkpoint-store.mjs";

import { sourceAudioProblem } from "./native-audio.mjs";

const local = new URL("./src/transcribe.mjs", import.meta.url);
const engine = fs.existsSync(local)
	? new URL("./src/", import.meta.url)
	: new URL("../../../vendor/ux-walk/src/", import.meta.url);

// Transcribers number voices per request and return no voiceprint, so nothing saved can match a voice
// across chunks. A person is named only when the walk says exactly who is talking: one configured
// speaker, microphone speech only, and under 2% of the words (the engine's stray-voice rule in
// speakers.mjs) outside each chunk's busiest voice.
function soleSpeaker(words, speakers) {
	if (speakers.length !== 1 || !words.length) return null;
	const jobs = new Map();
	for (const word of words) {
		if (!/^segment-\d+:microphone$/.test(word.source)) return null;
		const voices = jobs.get(word.jobId) ?? new Map();
		voices.set(word.speaker, (voices.get(word.speaker) ?? 0) + 1);
		jobs.set(word.jobId, voices);
	}
	let main = 0;
	for (const voices of jobs.values()) main += Math.max(...voices.values());
	return (words.length - main) / words.length < 0.02 ? speakers[0] : null;
}

const UNMATCHED_VOICES_NOTICE =
	"Speaker labels belong to one audio source and transcription chunk. Voices are not matched between them, so two labels can be the same person.";

export async function reuseCheckpointTranscript(
	directory,
	rows,
	startedAtMs,
	cfg = {},
	speakers = [],
) {
	const root = path.join(directory, "checkpoints");
	const jobsRoot = path.join(root, "jobs");
	if (!fs.existsSync(jobsRoot)) return { handled: false };
	const jobs = fs
		.readdirSync(jobsRoot)
		.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
		.map((name) => readJson(path.join(jobsRoot, name)));
	if (!jobs.length) {
		if (
			!fs.existsSync(path.join(root, "identity.json")) ||
			cfg.liveTranscription === false ||
			!["elevenlabs", "assemblyai"].includes(cfg.transcriber)
		)
			return { handled: false };
		if (sealedNoAudioCapture(directory, cfg))
			return {
				handled: true,
				error: null,
				results: new Map(
					rows.map((row) => [
						row.dir,
						{
							transcript: false,
							transcriptUnavailable: "No audio was selected for this recording",
						},
					]),
				),
			};
		const error =
			"Live transcription is pending or draining. Source audio is retained; reprocess after the checkpoint worker finishes.";
		return {
			handled: true,
			error,
			results: new Map(
				rows.map((row) => [
					row.dir,
					{ transcript: false, transcriptError: error },
				]),
			),
		};
	}
	const results = new Map();
	let error = null;
	let layout;
	try {
		layout = readJson(path.join(root, "final-layout.json"));
	} catch {
		error =
			"Live transcript source clocks are retained; final display alignment is not yet available. Retry preparation after checkpoint draining finishes.";
	}
	const mapped = [];
	let complete = jobs.every((job) => job.state === "complete");
	let base = 0;
	if (layout) {
		const config = layout.config ?? {};
		const spans = layout.displaySpans;
		const unsupported =
			layout.alignmentProblem ||
			sourceAudioProblem(null, config) ||
			!Array.isArray(spans) ||
			spans.length !== layout.meta?.segments?.length ||
			spans.some((span) => !(span > 0)) ||
			config.timeline?.segments?.some(
				(span, index) =>
					span.recordingSegment !== index ||
					span.start !== 0 ||
					span.timescale !== 1 ||
					(span.volume ?? 1) !== 1 ||
					Math.abs(span.end - spans[index]) > 0.15,
			);
		if (unsupported)
			error =
				"Live transcript is retained with source clocks; edited timeline alignment requires an explicit full transcription retry.";
		else
			for (const [index, segment] of layout.meta.segments.entries()) {
				const duration = spans[index];
				for (const [side, kind, gainKey] of [
					["mic", "microphone", "micVolumeDb"],
					["system_audio", "systemAudio", "systemVolumeDb"],
				]) {
					if (
						!segment[side] ||
						config.audio?.mute ||
						(config.audio?.[gainKey] ?? 0) < -30
					)
						continue;
					const source = `segment-${index}:${kind}`;
					const matching = jobs
						.filter((job) => job.source === source)
						.sort((a, b) => a.sourceStartMs - b.sourceStartMs);
					const tracks = [
						segment.display,
						segment.camera,
						segment.mic,
						segment.system_audio,
					].filter(Boolean);
					const latest = tracks.every((track) =>
						Number.isFinite(track.start_time),
					)
						? Math.max(...tracks.map((track) => track.start_time))
						: null;
					const clip = config.clips?.find(
						(item) => (item.index ?? 0) === index,
					);
					const offset = config.clips?.length
						? (clip?.offsets?.[side] ?? 0)
						: latest == null
							? 0
							: latest - segment[side].start_time;
					if (!Number.isFinite(offset)) {
						complete = false;
						continue;
					}
					let covered = 0;
					for (const job of matching) {
						if (job.state !== "complete" || job.sourceStartMs > covered + 1) {
							complete = false;
							continue;
						}
						const file = path.join(jobsRoot, `${job.jobId}.words.json`);
						if (
							!fs.existsSync(file) ||
							sha256(fs.readFileSync(file)) !== job.resultHash
						) {
							complete = false;
							continue;
						}
						const result = readJson(file);
						if (result.source !== source || !Array.isArray(result.words)) {
							complete = false;
							continue;
						}
						covered = Math.max(covered, job.sourceEndMs);
						for (const word of result.words) {
							const start = Math.max(base, base + word.start - offset);
							const end = Math.min(base + duration, base + word.end - offset);
							if (Number.isFinite(start) && end > start)
								mapped.push({ ...word, start, end, source, jobId: job.jobId });
						}
					}
					if (
						covered / 1000 <
						(layout.sourceDurations?.[source] ?? duration + offset) - 0.15
					)
						complete = false;
				}
				base += duration;
			}
	}
	if (!complete && !error)
		error =
			"Partial live transcript: some source audio is pending, failed or ambiguous. Saved jobs are reused without another automatic billable submission.";
	const { wordsToSrt } = await import(new URL("transcribe.mjs", engine));
	mapped.sort((a, b) => a.start - b.start || a.source.localeCompare(b.source));
	const sole = soleSpeaker(mapped, speakers);
	for (const row of rows) {
		const start = (row.startMs - startedAtMs) / 1000;
		const end = (row.endMs - startedAtMs) / 1000;
		const words = mapped
			.filter((word) => word.end > start && word.start < end)
			.map((word) => ({
				...word,
				start: Math.max(0, word.start - start),
				end: Math.min(end - start, word.end - start),
			}));
		const chapter = path.join(directory, row.dir);
		const srt = path.join(chapter, "transcript.srt");
		if (
			!words.length &&
			fs.existsSync(path.join(chapter, "transcript-sources.json")) &&
			fs.existsSync(srt)
		) {
			const bytes = fs.readFileSync(srt);
			durableWrite(
				path.join(
					chapter,
					`transcript-source-${sha256(bytes).slice(0, 12)}.srt`,
				),
				bytes,
			);
			fs.unlinkSync(srt);
		}
		durableJson(path.join(chapter, "transcript-sources.json"), {
			schemaVersion: 1,
			words,
			complete: !error,
			speakerIdentity: sole
				? `One configured speaker and microphone speech only: every label here is ${sole}`
				: "Labels belong to one source and chunk; identities are not matched across requests",
			...(error ? { error } : {}),
		});
		if (words.length)
			durableWrite(
				path.join(chapter, "transcript.srt"),
				wordsToSrt(
					sole ? words.map((word) => ({ ...word, speaker: sole })) : words,
				),
			);
		const labels = new Set(
			words.map((word) => `${word.jobId}:${word.speaker}`),
		);
		results.set(row.dir, {
			transcript: words.length > 0,
			speakers: sole ? [sole] : [],
			...(!sole && labels.size > 1
				? { speakerAttributionNotice: UNMATCHED_VOICES_NOTICE }
				: {}),
			...(error ? { transcriptError: error } : {}),
		});
	}
	return { handled: true, results, error };
}

function verifiedZeroJobSeal(directory, cfg, allowFullOwner = false) {
	if (
		cfg.liveTranscription === false ||
		!["elevenlabs", "assemblyai"].includes(cfg.transcriber)
	)
		return false;
	const root = path.join(directory, "checkpoints");
	try {
		const identity = readJson(path.join(root, "identity.json"));
		const seal = readJson(path.join(root, "seal.json"));
		if (
			seal.schemaVersion !== 1 ||
			seal.recordingId !== identity.recordingId ||
			seal.generation !== identity.generation ||
			seal.captureState !== "complete" ||
			seal.providerJobs !== 0
		)
			return false;
		if (fs.readdirSync(path.join(root, "jobs")).length) return false;
		const names = fs
			.readdirSync(path.join(root, "descriptors"))
			.filter((name) => /^\d{12}\.json$/.test(name))
			.sort();
		const latest = fs.readFileSync(
			path.join(root, "descriptors", names.at(-1)),
		);
		if (
			sha256(latest) !== seal.descriptorHash ||
			JSON.parse(latest).sequence !== seal.sequence
		)
			return false;
		for (const name of names)
			if (
				readJson(path.join(root, "descriptors", name)).objects.some(
					(object) => object.kind === "transcriptWords",
				)
			)
				return false;
		const lock = path.join(directory, ".checkpoint-worker");
		if (fs.existsSync(lock)) {
			const owner = readJson(path.join(lock, "owner.json"));
			if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
			try {
				process.kill(owner.pid, 0);
				if (
					!(
						allowFullOwner &&
						owner.pid === process.pid &&
						owner.kind === "full-transcript"
					)
				)
					return false;
			} catch (error) {
				if (error.code !== "ESRCH") return false;
			}
		}
		return {
			seal,
			root,
			descriptors: names.map((name) =>
				readJson(path.join(root, "descriptors", name)),
			),
		};
	} catch {
		return false;
	}
}

export function sealedUnsupportedFallback(
	directory,
	cfg,
	allowFullOwner = false,
) {
	const verified = verifiedZeroJobSeal(directory, cfg, allowFullOwner);
	return (
		!!verified && Object.keys(verified.seal.unsupportedSources ?? {}).length > 0
	);
}

export function sealedNoAudioCapture(directory, cfg) {
	const verified = verifiedZeroJobSeal(directory, cfg);
	if (!verified) return false;
	const { seal, root, descriptors } = verified;
	try {
		if (
			seal.expectedAudio?.microphone !== false ||
			seal.expectedAudio?.systemAudio !== false ||
			seal.sourceCaptureState !== "Complete" ||
			Object.keys(seal.unsupportedSources ?? {}).length ||
			!descriptors.at(-1)?.finalized ||
			descriptors.at(-1)?.captureState !== "complete" ||
			descriptors.some((descriptor) =>
				descriptor.objects.some((object) =>
					[
						"microphone",
						"systemAudio",
						"microphoneInit",
						"systemAudioInit",
					].includes(object.kind),
				),
			)
		)
			return false;
		const bytes = fs.readFileSync(path.join(root, "final-layout.json"));
		if (sha256(bytes) !== seal.finalLayoutHash) return false;
		const layout = JSON.parse(bytes);
		return (
			Array.isArray(layout.meta?.segments) &&
			layout.meta.segments.length > 0 &&
			layout.meta.segments.every(
				(segment) => !segment.mic && !segment.system_audio,
			) &&
			Array.isArray(layout.displaySpans) &&
			layout.displaySpans.length === layout.meta.segments.length &&
			layout.displaySpans.every((span) => Number.isFinite(span) && span > 0) &&
			Object.keys(layout.sourceDurations ?? {}).length === 0
		);
	} catch {
		return false;
	}
}
