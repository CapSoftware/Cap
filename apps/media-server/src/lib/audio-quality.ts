import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { spawn } from "bun";
import { z } from "zod";
import {
	type AudioQualityMeasurements,
	type AudioQualityProfile,
	planAudioQuality,
	validateAudioQualityMeasurements,
} from "./audio-quality-policy";
import { proveRecordingPackets } from "./recording-packet-proof";
import { registerSubprocess, unregisterSubprocess } from "./subprocess";

const streamSchema = z.object({
	codec_type: z.string(),
	codec_name: z.string(),
	channels: z.number().int().optional(),
	sample_rate: z.string().optional(),
	duration: z.string().optional(),
	start_time: z.string().optional(),
});
const probeSchema = z.object({ streams: z.array(streamSchema) });
const loudnessSchema = z.object({
	input_i: z.string(),
	input_tp: z.string(),
	input_lra: z.string(),
});

const localInputOptions = [
	"-protocol_whitelist",
	"file",
	"-format_whitelist",
	"mov,matroska,webm,avi,wav,mp3,flac,ogg,aac",
];

async function readBounded(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<string> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let exceeded = false;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > limit) exceeded = true;
			else chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (exceeded)
		throw new Error("Audio quality subprocess output exceeded limit");
	return Buffer.concat(chunks).toString("utf8");
}

async function run(
	args: string[],
	signal: AbortSignal,
	stdoutLimit = 1024 * 1024,
) {
	signal.throwIfAborted();
	const proc = registerSubprocess(
		spawn({ cmd: args, stdout: "pipe", stderr: "pipe", stdin: "ignore" }),
	);
	const abort = () => {
		if (proc.exitCode === null) proc.kill("SIGKILL");
	};
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	try {
		const [stdout, stderr, code] = await Promise.all([
			readBounded(proc.stdout, stdoutLimit),
			readBounded(proc.stderr, 128 * 1024),
			proc.exited,
		]);
		signal.throwIfAborted();
		if (code !== 0) throw new Error(`Audio quality subprocess exited ${code}`);
		return { stdout, stderr };
	} finally {
		if (proc.exitCode === null) proc.kill("SIGKILL");
		await proc.exited;
		signal.removeEventListener("abort", abort);
		unregisterSubprocess(proc);
	}
}

async function fingerprint(path: string, signal: AbortSignal) {
	const before = await lstat(path, { bigint: true });
	if (!before.isFile())
		throw new Error("Audio quality requires a regular file");
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path, { signal }))
		hash.update(chunk);
	const after = await lstat(path, { bigint: true });
	if (
		before.ino !== after.ino ||
		before.dev !== after.dev ||
		before.size !== after.size ||
		before.mtimeNs !== after.mtimeNs ||
		before.ctimeNs !== after.ctimeNs
	)
		throw new Error("Audio quality source changed during hashing");
	return hash.digest("hex");
}

async function probe(path: string, signal: AbortSignal) {
	const result = await run(
		[
			"ffprobe",
			"-v",
			"error",
			...localInputOptions,
			"-show_streams",
			"-of",
			"json",
			path,
		],
		signal,
	);
	return probeSchema.parse(JSON.parse(result.stdout)).streams;
}

async function hasContinuousAudioTimeline(
	path: string,
	measurements: AudioQualityMeasurements,
	startTime: number,
	signal: AbortSignal,
): Promise<boolean> {
	const result = await run(
		[
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"a:0",
			"-show_entries",
			"frame=pts_time,nb_samples",
			"-of",
			"csv=p=0",
			...localInputOptions,
			path,
		],
		signal,
		8 * 1024 * 1024,
	);
	let samples = 0;
	for (const line of result.stdout.trim().split("\n")) {
		const fields = line.trim().split(",");
		if (fields.length !== 2 || !fields[0] || !fields[1]) return false;
		const pts = Number(fields[0]);
		const count = Number(fields[1]);
		if (
			!Number.isFinite(pts) ||
			!Number.isSafeInteger(count) ||
			count <= 0 ||
			Math.abs(pts - startTime - samples / measurements.sampleRate) >
				1 / measurements.sampleRate
		)
			return false;
		samples += count;
	}
	return samples === measurements.sampleCount;
}

export async function measureAudioQuality(
	path: string,
	signal: AbortSignal,
): Promise<AudioQualityMeasurements> {
	const streams = await probe(path, signal);
	const audio = streams.filter((stream) => stream.codec_type === "audio");
	const stream = audio[0];
	if (audio.length !== 1 || !stream)
		throw new Error("Audio quality requires exactly one audio stream");
	const result = await run(
		[
			"ffmpeg",
			"-hide_banner",
			"-nostdin",
			"-nostats",
			"-threads",
			"1",
			...localInputOptions,
			"-i",
			path,
			"-map",
			"0:a:0",
			"-af",
			"astats=measure_perchannel=none:measure_overall=Number_of_samples,loudnorm=I=-16:TP=-2:LRA=11:dual_mono=true:print_format=json",
			"-f",
			"null",
			"-",
		],
		signal,
	);
	const start = result.stderr.lastIndexOf("{");
	const end = result.stderr.lastIndexOf("}");
	const values = loudnessSchema.parse(
		JSON.parse(result.stderr.slice(start, end + 1)),
	);
	return {
		lufs: Number(values.input_i),
		truePeak: Number(values.input_tp),
		lra: Number(values.input_lra),
		duration: Number(stream.duration),
		channels: stream.channels ?? 0,
		sampleRate: Number(stream.sample_rate),
		sampleCount: Number(result.stderr.match(/Number of samples: (\d+)/)?.[1]),
	};
}

export type AudioQualityResult =
	| { status: "unchanged"; reason: string }
	| {
			status: "shadow-candidate";
			path: string;
			sourceSha256: string;
			outputSha256: string;
			input: AudioQualityMeasurements;
			output: AudioQualityMeasurements;
			profile: AudioQualityProfile;
			version: "audio-quality-v3";
			peakCorrectionDb: number;
			validationFailures: string[];
			elapsedMs: number;
			cleanup: () => Promise<void>;
	  };

export async function createAudioQualityCandidate(
	sourcePath: string,
	options: {
		mode: "off" | "shadow";
		profile: AudioQualityProfile;
		speechOnlyConfirmed?: boolean;
		abortSignal?: AbortSignal;
		timeoutMs?: number;
	},
): Promise<AudioQualityResult> {
	if (options.mode !== "shadow")
		return { status: "unchanged", reason: "disabled" };
	if (!isAbsolute(sourcePath))
		throw new Error("Audio quality requires an absolute local source path");
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error("Audio quality timed out")),
		Math.min(30 * 60_000, Math.max(1, options.timeoutMs ?? 10 * 60_000)),
	);
	const signal = options.abortSignal
		? AbortSignal.any([controller.signal, options.abortSignal])
		: controller.signal;
	const started = performance.now();
	let directory: string | undefined;
	try {
		const sourceSha256 = await fingerprint(sourcePath, signal);
		const streams = await probe(sourcePath, signal);
		const audioStreams = streams.filter((s) => s.codec_type === "audio");
		const videoStreams = streams.filter((s) => s.codec_type === "video");
		if (
			audioStreams.length !== 1 ||
			videoStreams.length > 1 ||
			streams.some((s) => !["audio", "video"].includes(s.codec_type))
		)
			return { status: "unchanged", reason: "unsupported-streams" };
		if (audioStreams[0]?.codec_name !== "aac")
			return { status: "unchanged", reason: "unsupported-audio-codec" };
		const input = await measureAudioQuality(sourcePath, signal);
		const plan = planAudioQuality(input, options);
		if (plan.kind === "skip")
			return { status: "unchanged", reason: plan.reason };
		const videoDuration = Number(videoStreams[0]?.duration);
		const sourceStart = Number(audioStreams[0]?.start_time);
		if (!Number.isFinite(sourceStart))
			return { status: "unchanged", reason: "unknown-source-start" };
		if (sourceStart !== 0)
			return { status: "unchanged", reason: "source-start-offset" };
		if (
			!(await hasContinuousAudioTimeline(
				sourcePath,
				input,
				sourceStart,
				signal,
			))
		)
			return { status: "unchanged", reason: "source-timeline-discontinuous" };
		if (
			videoStreams.length &&
			(!Number.isFinite(videoDuration) ||
				Math.abs(videoDuration - input.duration) > 0.1)
		)
			return { status: "unchanged", reason: "source-duration-mismatch" };
		directory = await mkdtemp(join(tmpdir(), "cap-audio-quality-"));
		let path = join(directory, "candidate.mp4");
		const renderArgs = [
			"ffmpeg",
			"-hide_banner",
			"-nostdin",
			"-nostats",
			"-v",
			"error",
			"-n",
			"-copyts",
			...localInputOptions,
			"-i",
			sourcePath,
			"-map",
			"0",
			"-map_metadata",
			"0",
			"-map_chapters",
			"0",
			"-c:v",
			"copy",
			"-af",
			`${plan.filter},aresample=${input.sampleRate},atrim=end_sample=${input.sampleCount},asettb=1/${input.sampleRate},asetpts=N`,
			"-filter_threads",
			"1",
			"-c:a",
			"aac",
			"-b:a",
			input.channels === 1 ? "192k" : "256k",
			"-ar",
			String(input.sampleRate),
			"-threads",
			"1",
			"-avoid_negative_ts",
			"disabled",
			"-movflags",
			"+faststart",
			path,
		];
		await run(renderArgs, signal);
		let output = await measureAudioQuality(path, signal);
		let peakCorrectionDb = 0;
		if (Number.isFinite(output.truePeak) && output.truePeak > -1) {
			const correction = -2 - output.truePeak;
			if (correction >= -6) {
				peakCorrectionDb = correction;
				path = join(directory, "candidate-limited.mp4");
				const args = [...renderArgs];
				const filterIndex = args.indexOf("-af") + 1;
				args[filterIndex] += `,volume=${correction.toFixed(6)}dB`;
				args[args.length - 1] = path;
				await run(args, signal);
				output = await measureAudioQuality(path, signal);
			}
		}
		await run(
			[
				"ffmpeg",
				"-v",
				"error",
				"-xerror",
				"-nostdin",
				...localInputOptions,
				"-i",
				path,
				"-f",
				"null",
				"-",
			],
			signal,
		);
		const validationFailures = validateAudioQualityMeasurements(
			input,
			output,
			plan.profile,
		);
		const outputStreams = await probe(path, signal);
		const inputStart = Number(audioStreams[0]?.start_time);
		const outputStart = Number(
			outputStreams.find((s) => s.codec_type === "audio")?.start_time,
		);
		if (
			!Number.isFinite(inputStart) ||
			!Number.isFinite(outputStart) ||
			Math.abs(inputStart - outputStart) > 1 / input.sampleRate
		)
			validationFailures.push("audio-start-changed");
		if (!(await hasContinuousAudioTimeline(path, output, outputStart, signal)))
			validationFailures.push("output-timeline-discontinuous");
		if (videoStreams.length)
			await proveRecordingPackets(sourcePath, null, path, signal);
		if ((await fingerprint(sourcePath, signal)) !== sourceSha256)
			throw new Error("Audio quality source changed during processing");
		const outputSha256 = await fingerprint(path, signal);
		const retainedDirectory = directory;
		directory = undefined;
		return {
			status: "shadow-candidate",
			path,
			sourceSha256,
			outputSha256,
			input,
			output,
			profile: plan.profile,
			version: plan.version,
			peakCorrectionDb,
			validationFailures,
			elapsedMs: performance.now() - started,
			cleanup: () => rm(retainedDirectory, { recursive: true, force: true }),
		};
	} finally {
		clearTimeout(timer);
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}
