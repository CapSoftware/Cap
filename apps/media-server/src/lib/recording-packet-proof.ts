import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
	RecordingTimingError,
	readRecordingVideoTiming,
} from "./recording-timing";
import { registerSubprocess, unregisterSubprocess } from "./subprocess";

export class RecordingPacketMismatchError extends Error {}

interface PacketStream {
	index: number;
	codec_type: "video" | "audio";
	time_base: string;
	[key: string]: unknown;
}

const STREAM_FIELDS =
	"index,start_pts,codec_type,codec_name,profile,level,codec_tag_string,width,height,sample_aspect_ratio,pix_fmt,color_range,color_space,color_transfer,color_primaries,chroma_location,field_order,refs,sample_fmt,sample_rate,channels,channel_layout,time_base,extradata_hash";

async function runInspector(
	command: string,
	args: string[],
	signal: AbortSignal,
	line: (value: string) => void,
) {
	signal.throwIfAborted();
	const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
	let error = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk: string) => {
		error = (error + chunk).slice(-8192);
	});
	const exited = new Promise<number>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (code) => resolve(code ?? -1));
	});
	if (!child.pid) {
		await exited;
		throw new Error("Recording packet inspector could not start");
	}
	const managed = registerSubprocess({
		pid: child.pid,
		exited,
		get exitCode() {
			return child.exitCode;
		},
		kill: (signal?: NodeJS.Signals | number) => child.kill(signal),
	});
	const stop = () => {
		child.kill("SIGKILL");
	};
	signal.addEventListener("abort", stop, { once: true });
	child.stdout.setEncoding("utf8");
	let pending = "";
	try {
		if (signal.aborted) stop();
		for await (const chunk of child.stdout) {
			if (typeof chunk !== "string")
				throw new Error("Recording packet metadata is invalid");
			pending += chunk;
			let newline = pending.indexOf("\n");
			while (newline !== -1) {
				if (newline > 65536)
					throw new Error("Recording packet metadata exceeds its bound");
				signal.throwIfAborted();
				line(pending.slice(0, newline).replace(/\r$/, ""));
				pending = pending.slice(newline + 1);
				newline = pending.indexOf("\n");
			}
			if (pending.length > 65536)
				throw new Error("Recording packet metadata exceeds its bound");
		}
		if (pending) line(pending);

		const code = await exited;
		signal.throwIfAborted();
		return { code, hasDiagnostics: Boolean(error) };
	} finally {
		stop();
		signal.removeEventListener("abort", stop);
		await exited.catch(() => {});
		unregisterSubprocess(managed);
	}
}

async function probe(
	path: string,
	args: string[],
	signal: AbortSignal,
	line: (value: string) => void,
) {
	const result = await runInspector(
		"ffprobe",
		[
			"-v",
			"error",
			"-err_detect",
			"explode",
			"-protocol_whitelist",
			"file",
			...args,
			path,
		],
		signal,
		line,
	);
	if (result.code !== 0 || result.hasDiagnostics)
		throw new Error("Recording packet inspection failed");
}

function time(value: string | undefined, base: string) {
	if (!value || !/^-?\d+$/.test(value))
		throw new Error("Recording packet timestamp is missing");
	const match = /^(\d+)\/(\d+)$/.exec(base);
	if (!match || BigInt(match[1]) <= 0n || BigInt(match[2]) <= 0n)
		throw new Error("Recording packet timebase is invalid");
	const numerator = BigInt(value) * BigInt(match[1]);
	let a = numerator < 0n ? -numerator : numerator;
	let b = BigInt(match[2]);
	while (b) [a, b] = [b, a % b];
	return `${numerator / a}/${BigInt(match[2]) / a}`;
}

const positiveInteger = z
	.number()
	.int()
	.positive()
	.max(Number.MAX_SAFE_INTEGER);
const audioTailSchema = z.object({
	packetCount: positiveInteger.optional(),
	durationTicks: positiveInteger,
	timeScale: positiveInteger,
	size: positiveInteger,
	hash: z.string().regex(/^SHA256:[a-f0-9]{64}$/),
});

export async function readRecordingAudioTail(
	path: string,
	signal: AbortSignal,
	countPackets = false,
) {
	try {
		if (!isAbsolute(path))
			throw new RecordingTimingError(
				"Recording audio timing is invalid",
				false,
			);
		let output = "";
		const result = await runInspector(
			process.execPath,
			[
				fileURLToPath(new URL("./recording-audio-timing.ts", import.meta.url)),
				path,
				countPackets ? "count" : "tail",
			],
			signal,
			(line) => {
				output += line;
				if (output.length > 65536)
					throw new Error("Audio timing metadata exceeds its bound");
			},
		);
		const decoded: unknown = JSON.parse(output);
		if (
			result.code === 1 &&
			typeof decoded === "object" &&
			decoded !== null &&
			"error" in decoded &&
			decoded.error === "invalid"
		)
			throw new RecordingTimingError(
				"Recording audio timing is invalid",
				false,
			);
		const parsed = audioTailSchema.safeParse(decoded);
		if (
			result.code !== 0 ||
			result.hasDiagnostics ||
			!parsed.success ||
			(countPackets && parsed.data.packetCount === undefined)
		)
			throw new Error("Recording audio timing response is invalid");
		return {
			...parsed.data,
			duration: time(
				String(parsed.data.durationTicks),
				`1/${parsed.data.timeScale}`,
			),
		};
	} catch (error) {
		if (error instanceof RecordingTimingError) throw error;
		const failure = new RecordingTimingError(
			"Recording audio timing inspection was interrupted",
			true,
		);
		failure.cause = error;
		throw failure;
	}
}

function seconds(rational: string): number {
	const [numerator, denominator] = rational.split("/").map(Number);
	return numerator / denominator;
}

// A compact per-packet record, kept only so a failed proof can say which packet differs.
class PacketLog {
	private capacity = 1024;
	length = 0;
	private pts = new Float64Array(this.capacity);
	private dts = new Float64Array(this.capacity);
	private sizes = new Uint32Array(this.capacity);
	private hashes = new Uint32Array(this.capacity);
	private keyframes = new Uint8Array(this.capacity);

	push(
		pts: string,
		dts: string,
		flags: string | undefined,
		size: string,
		dataHash: string,
	) {
		if (this.length === this.capacity) {
			this.capacity *= 2;
			const grow = <T extends Float64Array | Uint32Array | Uint8Array>(
				array: T,
			) => {
				const next = new (array.constructor as new (length: number) => T)(
					this.capacity,
				);
				next.set(array);
				return next;
			};
			this.pts = grow(this.pts);
			this.dts = grow(this.dts);
			this.sizes = grow(this.sizes);
			this.hashes = grow(this.hashes);
			this.keyframes = grow(this.keyframes);
		}
		this.pts[this.length] = seconds(pts);
		this.dts[this.length] = seconds(dts);
		this.sizes[this.length] = Number(size);
		this.hashes[this.length] = Number.parseInt(dataHash.slice(7, 15), 16);
		this.keyframes[this.length] =
			(flags?.includes("K") ? 1 : 0) | (flags?.includes("D") ? 2 : 0);
		this.length++;
	}

	at(index: number) {
		return {
			pts: this.pts[index],
			dts: this.dts[index],
			size: this.sizes[index],
			data: this.hashes[index],
			flags: this.keyframes[index],
		};
	}
}

function firstPacketDifference(source: PacketLog, output: PacketLog) {
	const shared = Math.min(source.length, output.length);
	for (let index = 0; index < shared; index++) {
		const left = source.at(index);
		const right = output.at(index);
		const fields = (Object.keys(left) as (keyof typeof left)[]).filter(
			(key) => left[key] !== right[key],
		);
		if (fields.length === 0) continue;
		const show = (key: keyof typeof left, value: number) =>
			key === "pts" || key === "dts" ? value.toFixed(6) : String(value);
		return `first difference at packet ${index}: ${fields
			.map((key) =>
				key === "data"
					? "data differs"
					: `${key} ${show(key, left[key])} vs ${show(key, right[key])}`,
			)
			.join(", ")}`;
	}
	if (source.length !== output.length)
		return `packet ${shared} exists only in the ${source.length > output.length ? "source" : "output"}`;
	return "packet proof differs, but the compact packet log did not capture the difference";
}

const MISMATCH_EXPLANATION_TIMEOUT_MS = 20_000;

// Packet logs are only collected in this second read, after a mismatch, so passing recordings pay nothing.
async function explainTrackMismatch(
	sourcePath: string,
	outputPath: string,
	kind: "video" | "audio",
	signal: AbortSignal,
): Promise<string> {
	// Bounded so explaining a mismatch cannot run the verification into its deadline and hide the mismatch.
	const explainSignal = AbortSignal.any([
		signal,
		AbortSignal.timeout(MISMATCH_EXPLANATION_TIMEOUT_MS),
	]);
	try {
		const [source, output] = await Promise.all([
			readTrack(sourcePath, kind, explainSignal, true),
			readTrack(outputPath, kind, explainSignal, true),
		]);
		return describeTrackDifference(source, output);
	} catch {
		return "details unavailable";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configurationDifferences(
	left: Record<string, unknown>,
	right: Record<string, unknown>,
	path = "",
): string[] {
	const parts: string[] = [];
	const value = (raw: unknown) => {
		const text = JSON.stringify(raw) ?? "none";
		return text.length > 40 ? `${text.slice(0, 37)}...` : text;
	};
	for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
		if (JSON.stringify(left[key]) === JSON.stringify(right[key])) continue;
		const [a, b] = [left[key], right[key]];
		if (!path && (isRecord(a) || isRecord(b)))
			parts.push(
				...configurationDifferences(
					isRecord(a) ? a : {},
					isRecord(b) ? b : {},
					`${key}.`,
				),
			);
		else parts.push(`${path}${key} ${value(a)} vs ${value(b)}`);
	}
	return parts;
}

export function describeTrackDifference(
	source: Pick<
		Awaited<ReturnType<typeof readTrack>>,
		"summary" | "log" | "timeBase"
	>,
	output: Pick<
		Awaited<ReturnType<typeof readTrack>>,
		"summary" | "log" | "timeBase"
	>,
): string {
	// Short, specific details go first so many changed tags cannot push them past the length cap.
	const parts: string[] = [];
	if (source.timeBase !== output.timeBase)
		parts.push(`time base ${source.timeBase} vs ${output.timeBase}`);
	if (
		source.summary.packets !== output.summary.packets &&
		source.log &&
		output.log
	)
		parts.push(firstPacketDifference(source.log, output.log));
	if (source.summary.count !== output.summary.count)
		parts.push(`packets ${source.summary.count} vs ${output.summary.count}`);
	if (source.summary.startTime !== output.summary.startTime)
		parts.push(
			`start ${source.summary.startTime} vs ${output.summary.startTime}`,
		);
	parts.push(
		...configurationDifferences(
			source.summary.configuration as Record<string, unknown>,
			output.summary.configuration as Record<string, unknown>,
		),
	);
	return parts.join("; ").slice(0, 400) || "track summaries differ";
}

async function readTrack(
	path: string,
	kind: "video" | "audio",
	signal: AbortSignal,
	keepLog = false,
) {
	if (!isAbsolute(path) || !(await lstat(path)).isFile())
		throw new Error("Recording packet proof requires local regular files");
	const selection = kind === "video" ? "v" : "a";
	let metadata = "";
	await probe(
		path,
		[
			"-select_streams",
			selection,
			"-show_streams",
			"-show_data_hash",
			"sha256",
			"-show_entries",
			`stream=${STREAM_FIELDS}:stream_side_data`,
			"-of",
			"json",
		],
		signal,
		(line) => {
			metadata += line;
			if (metadata.length > 65536)
				throw new Error("Recording stream metadata exceeds its bound");
		},
	);
	const parsed: unknown = JSON.parse(metadata);
	if (
		!parsed ||
		typeof parsed !== "object" ||
		!("streams" in parsed) ||
		!Array.isArray(parsed.streams) ||
		parsed.streams.length !== 1
	)
		throw new Error("Recording stream selection is ambiguous");
	const stream = parsed.streams[0] as PacketStream;
	if (
		stream.codec_type !== kind ||
		typeof stream.time_base !== "string" ||
		!Number.isSafeInteger(stream.index) ||
		typeof stream.extradata_hash !== "string" ||
		!/^SHA256:[a-f0-9]{64}$/.test(stream.extradata_hash)
	)
		throw new Error("Recording codec configuration is incomplete");
	const { index, time_base: base, start_pts: startPts, tags, ...rest } = stream;
	// Remuxing a fragmented source into a regular MP4 drops its track creation_time, which is
	// container metadata rather than anything in the encoded stream.
	const { creation_time: _creationTime, ...keptTags } =
		tags && typeof tags === "object" ? (tags as Record<string, unknown>) : {};
	const start = time(String(startPts), base);
	const configuration = {
		...rest,
		...(Object.keys(keptTags).length > 0 ? { tags: keptTags } : {}),
		start,
	};
	const [startNumerator, startDenominator] = start.split("/").map(Number);
	const startTime = startNumerator / startDenominator;
	if (!Number.isFinite(startTime))
		throw new Error("Recording start time is invalid");
	const tail =
		kind === "audio" ? await readRecordingAudioTail(path, signal) : undefined;
	const hash = createHash("sha256");
	const log = keepLog ? new PacketLog() : undefined;
	let count = 0;
	let pendingPacket: Record<string, string> | undefined;
	const commitPacket = (fields: Record<string, string>, nextDts?: string) => {
		let {
			stream_index: _index,
			pts,
			dts,
			duration,
			flags,
			...content
		} = fields;
		const skipSamples = Object.entries(content).find(
			([key]) => key === "skip_samples" || key.endsWith(":skip_samples"),
		)?.[1];
		// FFmpeg can omit only the fully skipped first AAC packet's duration in fragmented MP4.
		if (
			duration === "N/A" &&
			count === 0 &&
			kind === "audio" &&
			stream.codec_name === "aac" &&
			pts === dts &&
			/^-?\d+$/.test(dts ?? "") &&
			typeof nextDts === "string" &&
			/^-?\d+$/.test(nextDts) &&
			/^[1-9]\d*$/.test(skipSamples ?? "") &&
			typeof stream.sample_rate === "string" &&
			/^[1-9]\d*$/.test(stream.sample_rate)
		) {
			const inferred = String(BigInt(nextDts) - BigInt(dts));
			if (time(skipSamples, `1/${stream.sample_rate}`) === time(inferred, base))
				duration = inferred;
		}
		// MP4 can mark an AAC priming packet discardable while retaining identical skip-sample metadata.
		const packetFlags =
			kind === "audio" &&
			Object.entries(content).some(
				([key, value]) =>
					(key === "skip_samples" || key.endsWith(":skip_samples")) &&
					/^\d+$/.test(value) &&
					typeof stream.sample_rate === "string" &&
					/^\d+$/.test(stream.sample_rate) &&
					time(value, `1/${stream.sample_rate}`) === time(duration, base),
			)
				? flags?.replaceAll("D", "_")
				: flags;
		// FFmpeg 7 can replace a fragmented AAC tail's stored duration with its nominal frame duration.
		if (
			tail &&
			nextDts === undefined &&
			(String(tail.size) !== content.size || tail.hash !== content.data_hash)
		)
			throw new Error(
				"Recording audio tail does not match its packet inventory",
			);
		log?.push(
			time(pts, base),
			time(dts, base),
			packetFlags,
			content.size ?? "0",
			content.data_hash ?? "",
		);
		// Interior timing is bound by PTS/DTS; stored terminal durations are compared separately.
		hash.update(
			JSON.stringify({
				n: count++,
				pts: time(pts, base),
				dts: time(dts, base),
				flags: packetFlags,
				content,
			}),
		);
		hash.update("\n");
	};
	await probe(
		path,
		[
			"-select_streams",
			selection,
			"-show_packets",
			"-show_data_hash",
			"sha256",
			"-show_entries",
			"packet=stream_index,pts,dts,duration,size,flags,data_hash:packet_side_data",
			"-of",
			"compact",
		],
		signal,
		(line) => {
			if (!line.startsWith("packet|"))
				throw new Error("Unexpected recording packet metadata");
			const fields = Object.fromEntries(
				line
					.slice(7)
					.split("|")
					.map((field) => {
						const separator = field.indexOf("=");
						if (separator < 1)
							throw new Error("Invalid recording packet metadata");
						return [field.slice(0, separator), field.slice(separator + 1)];
					}),
			);
			if (
				Number(fields.stream_index) !== index ||
				!/^[1-9]\d*$/.test(fields.size ?? "") ||
				!/^SHA256:[a-f0-9]{64}$/.test(fields.data_hash ?? "")
			)
				throw new Error("Recording packet content is incomplete");
			if (pendingPacket) commitPacket(pendingPacket, fields.dts);
			pendingPacket = fields;
		},
	);
	if (pendingPacket) commitPacket(pendingPacket);
	if (!count) throw new Error("Recording stream contains no packets");
	return {
		summary: {
			configuration,
			count,
			packets: hash.digest("hex"),
			startTime,
			tail,
		},
		log,
		timeBase: base,
	};
}

export async function proveRecordingPackets(
	videoPath: string,
	audioPath: string | null,
	outputPath: string,
	signal: AbortSignal,
) {
	const paths = [
		...new Set([videoPath, ...(audioPath ? [audioPath] : []), outputPath]),
	];
	const before = await Promise.all(
		paths.map((path) => lstat(path, { bigint: true })),
	);
	// Every read below is independent and the files are pinned by `before`, so
	// run them together and still check their results in the original order.
	const reads = new AbortController();
	const readSignal = AbortSignal.any([signal, reads.signal]);
	const settled = <T>(promise: Promise<T>) => {
		promise.catch(() => {});
		return promise;
	};
	const timingOptions = { abortSignal: readSignal, timeoutMs: 45 * 60_000 };
	const sourceTimingRead = settled(
		readRecordingVideoTiming(videoPath, timingOptions),
	);
	const sourceVideoRead = settled(readTrack(videoPath, "video", readSignal));
	const outputVideoRead = settled(readTrack(outputPath, "video", readSignal));
	const sourceAudioRead = audioPath
		? settled(readTrack(audioPath, "audio", readSignal))
		: null;
	const outputAudioRead = audioPath
		? settled(readTrack(outputPath, "audio", readSignal))
		: null;
	const outputTimingRead = settled(
		readRecordingVideoTiming(outputPath, timingOptions),
	);
	let sourceTiming: Awaited<typeof sourceTimingRead>;
	let outputTiming: Awaited<typeof outputTimingRead>;
	let sourceVideo: Awaited<typeof sourceVideoRead>["summary"];
	let outputVideo: Awaited<typeof outputVideoRead>["summary"];
	try {
		sourceTiming = await sourceTimingRead;
		if (sourceTiming.terminalPacketCount !== 1)
			throw new Error("Tied terminal samples require decoded source evidence");
		sourceVideo = (await sourceVideoRead).summary;
		outputVideo = (await outputVideoRead).summary;
		if (JSON.stringify(sourceVideo) !== JSON.stringify(outputVideo))
			throw new RecordingPacketMismatchError(
				`Recording encoded video does not preserve the source (${await explainTrackMismatch(videoPath, outputPath, "video", signal)})`,
			);
		if (audioPath && sourceAudioRead && outputAudioRead) {
			const { tail: sourceTail, ...sourceAudio } = (await sourceAudioRead)
				.summary;
			const { tail: outputTail, ...outputAudio } = (await outputAudioRead)
				.summary;
			if (JSON.stringify(sourceAudio) !== JSON.stringify(outputAudio))
				throw new RecordingPacketMismatchError(
					`Recording encoded audio does not preserve the source (${await explainTrackMismatch(audioPath, outputPath, "audio", signal)})`,
				);
			// MP4 edit-list rounding can change the reported AAC tail without changing decoded samples.
			if (sourceTail?.duration !== outputTail?.duration)
				throw new Error(
					"Recording audio tail requires decoded source evidence",
				);
		}
		outputTiming = await outputTimingRead;
	} finally {
		reads.abort();
	}
	const normalizeTiming = (timing: typeof sourceTiming) => ({
		packets: timing.packetTimelineSha256,
		terminalPackets: timing.terminalPacketCount,
		terminalContent: timing.terminalPacketSha256,
		duration: time(String(timing.lastDurationTicks), `1/${timing.timeScale}`),
	});
	if (
		JSON.stringify(normalizeTiming(sourceTiming)) !==
		JSON.stringify(normalizeTiming(outputTiming))
	)
		throw new RecordingPacketMismatchError(
			"Recording terminal packet timing changed",
		);
	const assertUnchanged = async () => {
		for (const [index, path] of paths.entries()) {
			const after = await lstat(path, { bigint: true });
			const initial = before[index];
			if (
				!after.isFile() ||
				after.dev !== initial.dev ||
				after.ino !== initial.ino ||
				after.size !== initial.size ||
				after.mtimeNs !== initial.mtimeNs ||
				after.ctimeNs !== initial.ctimeNs
			)
				throw new RecordingTimingError(
					"Recording changed during packet verification",
					false,
				);
		}
		signal.throwIfAborted();
	};
	await assertUnchanged();
	return {
		hasAudio: Boolean(audioPath),
		videoPackets: sourceVideo.count,
		videoStartTime: outputVideo.startTime,
		outputTiming,
		assertUnchanged,
	};
}
