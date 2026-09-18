import { execFile } from "node:child_process";
import { chmod, lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { validCapBundlePath } from "@cap/editor-cap-bundle";
import {
	type EditorCapAsset,
	stageSignedEditorCapAsset,
	validateEditorCapAsset,
} from "./editor-cap-assets";
import { nativeEditorBinary } from "./editor-native";

const runFile = promisify(execFile);
const MAX_AUDIO_GENERATION_MS = 30 * 60 * 1000;
const AUDIO_EXTENSIONS = new Set([
	".aac",
	".flac",
	".m4a",
	".mp3",
	".mp4",
	".ogg",
	".wav",
	".webm",
]);
const VIDEO_EXTENSIONS = new Set([
	".avi",
	".flv",
	".m4v",
	".mkv",
	".mov",
	".mp4",
	".webm",
	".wmv",
]);

type ExpectedSegment = {
	mediaDurationMs: number;
	segmentDurationMs: number;
	hasAudio: boolean;
};
type SourceTrack = {
	path: string;
	start_time?: number | null;
};
type SourceSegment = {
	display: SourceTrack;
	camera?: SourceTrack | null;
	mic?: SourceTrack | null;
	system_audio?: SourceTrack | null;
};

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validExpectedSegments(segments: readonly ExpectedSegment[]) {
	return (
		segments.length >= 1 &&
		segments.length <= 1000 &&
		segments.every(
			(segment) =>
				Number.isSafeInteger(segment.mediaDurationMs) &&
				segment.mediaDurationMs > 0 &&
				segment.mediaDurationMs <= 86_400_000 &&
				Number.isSafeInteger(segment.segmentDurationMs) &&
				segment.segmentDurationMs >= segment.mediaDurationMs &&
				segment.segmentDurationMs <= 86_400_000 &&
				typeof segment.hasAudio === "boolean",
		)
	);
}

function sourceTrack(value: unknown): SourceTrack | null {
	if (
		!record(value) ||
		typeof value.path !== "string" ||
		!validCapBundlePath(value.path) ||
		(value.start_time !== undefined &&
			value.start_time !== null &&
			(typeof value.start_time !== "number" ||
				!Number.isFinite(value.start_time)))
	) {
		return null;
	}
	return {
		path: value.path,
		start_time: typeof value.start_time === "number" ? value.start_time : null,
	};
}

function parseSourceSegments(value: unknown): SourceSegment[] {
	if (
		!record(value) ||
		!Array.isArray(value.segments) ||
		value.segments.length < 1 ||
		value.segments.length > 1000
	) {
		throw new Error("Cap source audio inspection was invalid");
	}
	return value.segments.map((item: unknown) => {
		if (!record(item)) {
			throw new Error("Cap source audio segment was invalid");
		}
		const display = sourceTrack(item.display);
		if (
			!display ||
			!VIDEO_EXTENSIONS.has(extname(display.path).toLowerCase())
		) {
			throw new Error("Cap source display media was invalid");
		}
		const camera =
			item.camera === null || item.camera === undefined
				? null
				: sourceTrack(item.camera);
		const mic =
			item.mic === null || item.mic === undefined
				? null
				: sourceTrack(item.mic);
		const systemAudio =
			item.system_audio === null || item.system_audio === undefined
				? null
				: sourceTrack(item.system_audio);
		if (
			(item.camera !== null && item.camera !== undefined && !camera) ||
			(item.mic !== null && item.mic !== undefined && !mic) ||
			(item.system_audio !== null &&
				item.system_audio !== undefined &&
				!systemAudio) ||
			(camera && !VIDEO_EXTENSIONS.has(extname(camera.path).toLowerCase())) ||
			(mic && !AUDIO_EXTENSIONS.has(extname(mic.path).toLowerCase())) ||
			(systemAudio &&
				!AUDIO_EXTENSIONS.has(extname(systemAudio.path).toLowerCase()))
		) {
			throw new Error("Cap source voice media was invalid");
		}
		return {
			display,
			camera,
			mic,
			system_audio: systemAudio,
		};
	});
}

async function checkedMediaPath(projectPath: string, path: string) {
	const absolute = join(projectPath, path);
	const metadata = await lstat(absolute);
	if (!metadata.isFile() || metadata.size <= 0) {
		throw new Error("Cap source media is unavailable");
	}
	return absolute;
}

async function probeDuration(path: string, signal?: AbortSignal) {
	const { stdout } = await runFile(
		"ffprobe",
		[
			"-v",
			"error",
			"-show_entries",
			"format=duration",
			"-of",
			"default=nw=1:nk=1",
			path,
		],
		{ timeout: 60_000, maxBuffer: 64 * 1024, signal },
	);
	const seconds = Number(stdout.trim());
	if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86_400) {
		throw new Error("Cap source media duration is invalid");
	}
	return seconds;
}

function trackOffset(display: SourceTrack, audio: SourceTrack) {
	if (
		typeof display.start_time !== "number" ||
		typeof audio.start_time !== "number"
	) {
		return 0;
	}
	const offset = audio.start_time - display.start_time;
	if (!Number.isFinite(offset) || Math.abs(offset) > 30) {
		throw new Error("Cap source voice timing is invalid");
	}
	return offset;
}

async function renderSegmentAudio(
	projectPath: string,
	segment: SourceSegment,
	expected: ExpectedSegment,
	outputPath: string,
	signal?: AbortSignal,
) {
	const displayPath = await checkedMediaPath(projectPath, segment.display.path);
	const displayDurationMs = Math.round(
		(await probeDuration(displayPath, signal)) * 1000,
	);
	if (Math.abs(displayDurationMs - expected.mediaDurationMs) > 2000) {
		throw new Error("Cap source display duration changed");
	}
	const durationSeconds = (expected.segmentDurationMs / 1000).toFixed(3);
	const voiceTracks = expected.hasAudio
		? [segment.mic, segment.system_audio]
				.filter(
					(track): track is SourceTrack =>
						track !== null && track !== undefined,
				)
				.filter(
					(track, index, tracks) =>
						tracks.findIndex((candidate) => candidate.path === track.path) ===
						index,
				)
		: [];
	if (expected.hasAudio && voiceTracks.length === 0) {
		throw new Error("Cap source voice tracks changed");
	}
	const inputArguments: string[] = [];
	const filters: string[] = [];
	for (const [index, track] of voiceTracks.entries()) {
		const path = await checkedMediaPath(projectPath, track.path);
		inputArguments.push("-i", path);
		const offset = trackOffset(segment.display, track);
		let filter = `[${index}:a:0]aresample=16000,aformat=channel_layouts=mono`;
		if (offset < 0) filter += `,atrim=start=${(-offset).toFixed(6)}`;
		filter += ",asetpts=PTS-STARTPTS";
		if (offset > 0) filter += `,adelay=${Math.round(offset * 1000)}`;
		filters.push(`${filter}[voice${index}]`);
	}
	if (voiceTracks.length === 0) {
		inputArguments.push(
			"-f",
			"lavfi",
			"-i",
			"anullsrc=channel_layout=mono:sample_rate=16000",
		);
		filters.push(
			`[0:a:0]atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[out]`,
		);
	} else {
		const labels = voiceTracks.map((_, index) => `[voice${index}]`).join("");
		const mix =
			voiceTracks.length === 1
				? labels
				: `${labels}amix=inputs=${voiceTracks.length}:duration=longest:normalize=0,`;
		filters.push(
			`${mix}apad,atrim=duration=${durationSeconds},asetpts=PTS-STARTPTS[out]`,
		);
	}
	await runFile(
		"ffmpeg",
		[
			"-hide_banner",
			"-loglevel",
			"error",
			...inputArguments,
			"-filter_complex",
			filters.join(";"),
			"-map",
			"[out]",
			"-vn",
			"-c:a",
			"aac",
			"-b:a",
			"64k",
			"-ar",
			"16000",
			"-ac",
			"1",
			"-n",
			outputPath,
		],
		{
			timeout: MAX_AUDIO_GENERATION_MS,
			maxBuffer: 64 * 1024,
			signal,
		},
	);
}

export async function prepareEditorCapCaptionAudio(
	asset: EditorCapAsset,
	expectedSegments: readonly ExpectedSegment[],
	signal?: AbortSignal,
) {
	validateEditorCapAsset(asset);
	if (!validExpectedSegments(expectedSegments)) {
		throw new Error("Cap caption source timing is invalid");
	}
	const root = await mkdtemp(join(tmpdir(), "cap-editor-cap-captions-"));
	await chmod(root, 0o700);
	const cleanup = () => rm(root, { recursive: true, force: true });
	try {
		const staged = await stageSignedEditorCapAsset(root, asset, signal);
		const { stdout } = await runFile(
			nativeEditorBinary("prepare"),
			["inspect-cap-audio", staged.path],
			{
				timeout: 60_000,
				maxBuffer: 2 * 1024 * 1024,
				signal,
			},
		);
		const sourceSegments = parseSourceSegments(JSON.parse(stdout));
		if (sourceSegments.length !== expectedSegments.length) {
			throw new Error("Cap caption source clip count changed");
		}
		for (const [index, source] of sourceSegments.entries()) {
			const expected = expectedSegments[index];
			if (!expected) throw new Error("Cap caption source timing changed");
			await renderSegmentAudio(
				staged.path,
				source,
				expected,
				join(root, `clip-${index}.m4a`),
				signal,
			);
		}
		await staged.cleanup();
		const concatPath = join(root, "clips.ffconcat");
		await writeFile(
			concatPath,
			`ffconcat version 1.0\n${expectedSegments
				.map(
					(segment, index) =>
						`file 'clip-${index}.m4a'\nduration ${(
							segment.segmentDurationMs / 1000
						).toFixed(3)}\n`,
				)
				.join("")}`,
			{ flag: "wx", mode: 0o600 },
		);
		const outputPath = join(root, "captions.m4a");
		await runFile(
			"ffmpeg",
			[
				"-hide_banner",
				"-loglevel",
				"error",
				"-f",
				"concat",
				"-safe",
				"0",
				"-i",
				concatPath,
				"-vn",
				"-c:a",
				"aac",
				"-b:a",
				"64k",
				"-ar",
				"16000",
				"-ac",
				"1",
				"-n",
				outputPath,
			],
			{
				timeout: MAX_AUDIO_GENERATION_MS,
				maxBuffer: 64 * 1024,
				signal,
			},
		);
		const expectedMs = expectedSegments.reduce(
			(total, segment) => total + segment.segmentDurationMs,
			0,
		);
		const actualMs = Math.round(
			(await probeDuration(outputPath, signal)) * 1000,
		);
		if (Math.abs(expectedMs - actualMs) > 250) {
			throw new Error("Cap caption audio timing changed");
		}
		const metadata = await lstat(outputPath);
		if (!metadata.isFile() || metadata.size <= 0) {
			throw new Error("Cap caption audio is unavailable");
		}
		return { path: outputPath, size: metadata.size, cleanup };
	} catch (error) {
		await cleanup();
		throw error;
	}
}
