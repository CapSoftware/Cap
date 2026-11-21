import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	truncateSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EncodedHlsLadder,
	encodeHlsLadder,
} from "../../lib/hls-ladder-encode";
import { verifyHlsLadder } from "../../lib/hls-ladder-verify";
import { probeVideoFile } from "../../lib/media-probe";
import { runTranscodeCommand } from "../../lib/media-video";

const directory = mkdtempSync(join(tmpdir(), "cap-ladder-verify-"));
const source = join(directory, "source.mp4");
const longer = join(directory, "longer.mp4");
const trimmed = join(directory, "trimmed.mp4");
const ladders: EncodedHlsLadder[] = [];

function writeSource(path: string, seconds: number, gop = "60") {
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		`testsrc2=size=1280x720:rate=30:duration=${seconds}`,
		"-f",
		"lavfi",
		"-i",
		`sine=frequency=440:duration=${seconds}:sample_rate=48000`,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-g",
		gop,
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-y",
		path,
	]);
}

async function encode(path = source): Promise<EncodedHlsLadder> {
	const ladder = await encodeHlsLadder(path, await probeVideoFile(path));
	ladders.push(ladder);
	return ladder;
}

function verify(ladder: EncodedHlsLadder, sourcePath = source) {
	return verifyHlsLadder({
		sourcePath,
		ladder,
		timeoutMs: 60_000,
		niceness: 10,
	});
}

beforeAll(() => {
	writeSource(source, 2);
	writeSource(longer, 3);
	const uncut = join(directory, "uncut.mp4");
	writeSource(uncut, 4, "120");
	execFileSync("ffmpeg", [
		"-v",
		"error",
		"-ss",
		"1.5",
		"-i",
		uncut,
		"-c",
		"copy",
		"-y",
		trimmed,
	]);
});

afterAll(async () => {
	await Promise.all(ladders.map((ladder) => ladder.cleanup()));
	rmSync(directory, { recursive: true, force: true });
});

describe("verifyHlsLadder", () => {
	test("passes a ladder that decodes and matches the source", async () => {
		const ladder = await encode();
		expect(ladder.result.renditions.map((rendition) => rendition.name)).toEqual(
			["720p", "360p"],
		);
		expect(ladder.result.audio).not.toBeNull();
		await verify(ladder);
	});

	test("measures an MP4 cut between keyframes by the frames it shows", async () => {
		await verify(await encode(trimmed), trimmed);
	});

	test("names each rendition that does not match the source length", async () => {
		const ladder = await encode();
		const failure = await verify(ladder, longer).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		const message = (failure as Error).message;
		expect(message).toContain(
			"720p video lasts 2.000s, expected 3.000s within 0.033s",
		);
		expect(message).toContain(
			"360p video lasts 2.000s, expected 3.000s within 0.033s",
		);
		expect(message).toMatch(/audio audio lasts 2\.\d{3}s, expected 3\.\d{3}s/);
	});

	test("fails a rendition whose media is cut short", async () => {
		const ladder = await encode();
		const media = ladder.files.find((file) => file.name === "360p.m4s");
		if (!media) throw new Error("missing 360p.m4s");
		truncateSync(media.path, Math.floor(media.bytes / 2));
		const failure = await verify(ladder).catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).toContain("360p");
		expect((failure as Error).message).not.toContain("720p");
	});
});

function ffmpegPid(marker: string): number | null {
	if (existsSync("/proc/self/task")) {
		for (const entry of readdirSync("/proc")) {
			if (!/^\d+$/.test(entry)) continue;
			try {
				if (readFileSync(`/proc/${entry}/cmdline`, "utf8").includes(marker))
					return Number(entry);
			} catch {}
		}
		return null;
	}
	const line = execFileSync("ps", ["-A", "-o", "pid=,args="], {
		encoding: "utf8",
	})
		.split("\n")
		.find((row) => row.includes(marker) && row.includes("ffmpeg"));
	return line ? Number.parseInt(line.trim(), 10) : null;
}

function threadNiceness(pid: number): number[] {
	return readdirSync(`/proc/${pid}/task`).map((thread) => {
		const stat = readFileSync(`/proc/${pid}/task/${thread}/stat`, "utf8");
		return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[16]);
	});
}

async function ffmpegPriority(name: string, niceness?: number) {
	const output = join(directory, name);
	const seen: { process: number; threads: number[] }[] = [];
	await runTranscodeCommand(
		[
			"ffmpeg",
			"-re",
			"-f",
			"lavfi",
			"-i",
			"testsrc2=size=640x360:rate=30:duration=1.5",
			"-c:v",
			"libx264",
			"-preset",
			"ultrafast",
			"-threads",
			"4",
			"-stats_period",
			"0.2",
			"-progress",
			"pipe:2",
			"-y",
			output,
		],
		output,
		1_500_000,
		30_000,
		() => {
			if (seen.length > 0) return;
			const pid = ffmpegPid(output);
			if (pid === null) return;
			seen.push({
				process: os.getPriority(pid),
				threads: existsSync("/proc/self/task") ? threadNiceness(pid) : [],
			});
		},
		undefined,
		undefined,
		niceness,
	);
	expect(seen.length).toBe(1);
	return seen[0] ?? { process: Number.NaN, threads: [] };
}

describe("runTranscodeCommand niceness", () => {
	test("runs FFmpeg and every thread it starts at the lower priority", async () => {
		const seen = await ffmpegPriority("niced.mp4", 10);
		expect(seen.process).toBe(10);
		for (const niceness of seen.threads) expect(niceness).toBe(10);
	});

	test("leaves FFmpeg at the server's priority without a niceness", async () => {
		const own = os.getPriority();
		const seen = await ffmpegPriority("default.mp4");
		expect(seen.process).toBe(own);
		for (const niceness of seen.threads) expect(niceness).toBe(own);
	});
});
