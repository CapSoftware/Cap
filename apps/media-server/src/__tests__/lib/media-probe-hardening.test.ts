import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxEncodeSeconds } from "../../lib/media-common";
import { UNSUPPORTED_FORMAT_MESSAGE } from "../../lib/media-input-policy";
import {
	isUnreadableMediaInput,
	probeVideoFile,
	UnreadableMediaInputError,
} from "../../lib/media-probe";
import { stopProbeWorkers } from "../../lib/media-probe-pool";

let dir = "";

async function ffmpeg(args: string[]): Promise<void> {
	const proc = Bun.spawn(["ffmpeg", "-v", "error", "-y", ...args], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [code, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(stderr);
}

// Rewrites the movie, track and media durations of an MP4 to one second,
// leaving its samples and edit list where they are.
function declareOneSecond(bytes: Uint8Array): Uint8Array {
	const data = Buffer.from(bytes);
	const walk = (start: number, end: number) => {
		let offset = start;
		while (offset + 8 <= end) {
			let size = data.readUInt32BE(offset);
			const type = data.toString("latin1", offset + 4, offset + 8);
			let header = 8;
			if (size === 1) {
				size = Number(data.readBigUInt64BE(offset + 8));
				header = 16;
			}
			if (size === 0) size = end - offset;
			const body = offset + header;
			if (["moov", "trak", "mdia", "edts"].includes(type)) {
				walk(body, offset + size);
			} else if (data[body] === 0) {
				if (type === "mvhd" || type === "mdhd") {
					data.writeUInt32BE(data.readUInt32BE(body + 12), body + 16);
				} else if (type === "tkhd") {
					data.writeUInt32BE(1000, body + 20);
				}
			}
			offset += size;
		}
	};
	walk(0, data.length);
	return data;
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "probe-hardening-"));
	const source = ["-f", "lavfi", "-i", "testsrc=d=1:s=128x96:r=10"];
	await ffmpeg([...source, "-c:v", "mpeg4", join(dir, "part2.mp4")]);
	await ffmpeg([...source, "-c:v", "mpeg2video", join(dir, "mpeg2.mkv")]);
	await ffmpeg([
		...source,
		"-f",
		"lavfi",
		"-i",
		"sine=d=1",
		"-c:v",
		"mpeg2video",
		"-c:a",
		"mp2",
		"-f",
		"mpegts",
		join(dir, "broadcast.ts"),
	]);
	await ffmpeg(["-f", "lavfi", "-i", "sine=d=1", join(dir, "audio-only.m4a")]);
	await ffmpeg([...source, "-c:v", "prores_ks", join(dir, "prores.mov")]);
	// Three frames an hour apart.
	await ffmpeg([
		"-f",
		"lavfi",
		"-i",
		"testsrc=s=128x96:r=1",
		"-vf",
		"setpts=N*3600/TB",
		"-frames:v",
		"3",
		"-c:v",
		"libx264",
		"-fps_mode",
		"passthrough",
		"-video_track_timescale",
		"1000",
		join(dir, "spread.mp4"),
	]);
	await writeFile(
		join(dir, "declared-short.mp4"),
		declareOneSecond(await readFile(join(dir, "spread.mp4"))),
	);
}, 60_000);

afterAll(async () => {
	stopProbeWorkers();
	await rm(dir, { recursive: true, force: true });
});

async function probeError(name: string): Promise<unknown> {
	return await probeVideoFile(join(dir, name)).then(
		() => null,
		(error: unknown) => error,
	);
}

describe("probe input checks", () => {
	test("a track the parser cannot read is unreadable input, not a server error", async () => {
		const error = await probeError("part2.mp4");
		expect(error).toBeInstanceOf(UnreadableMediaInputError);
		expect(isUnreadableMediaInput(error)).toBe(true);
	}, 30_000);

	test("a video codec outside the allowed list is refused", async () => {
		const error = await probeError("mpeg2.mkv");
		expect(error).toBeInstanceOf(UnreadableMediaInputError);
		expect((error as Error).message).toContain("not supported");
	}, 30_000);

	test("a video track the parser cannot read is an unsupported format, not a missing track", async () => {
		const error = await probeError("broadcast.ts");
		expect(error).toBeInstanceOf(UnreadableMediaInputError);
		expect((error as Error).message).toBe(UNSUPPORTED_FORMAT_MESSAGE);
	}, 30_000);

	test("a file with no video at all still says so", async () => {
		const error = await probeError("audio-only.m4a");
		expect((error as Error).message).toBe("No video stream found");
	}, 30_000);

	test("an allowed codec the parser does not name is still accepted", async () => {
		const metadata = await probeVideoFile(join(dir, "prores.mov"));
		expect(metadata.width).toBe(128);
	}, 30_000);
});

describe("a codec check that cannot run", () => {
	test("leaves an allowed codec retryable instead of refusing it", async () => {
		const savedPath = process.env.PATH;
		const real = Bun.which("ffprobe");
		const shim = join(dir, "failing-bin");
		// An ffprobe that cannot read the stream list, as when the source
		// fails to fetch.
		await Bun.write(
			join(shim, "ffprobe"),
			`#!/bin/sh\ncase "$*" in *codec_type,codec_name*) echo "Server returned 5XX Server Error reply" >&2; exit 1 ;; esac\nexec "${real}" "$@"\n`,
		);
		await chmod(join(shim, "ffprobe"), 0o755);
		process.env.PATH = `${shim}:${savedPath}`;
		try {
			const error = await probeError("prores.mov");
			expect(error).toBeInstanceOf(Error);
			expect(isUnreadableMediaInput(error)).toBe(false);
		} finally {
			process.env.PATH = savedPath;
		}
	}, 30_000);
});

describe("probed duration", () => {
	test("a header that declares less than the timestamps span reports the span", async () => {
		const honest = await probeVideoFile(join(dir, "spread.mp4"));
		const lying = await probeVideoFile(join(dir, "declared-short.mp4"));
		expect(honest.duration).toBeGreaterThanOrEqual(7200);
		expect(lying.duration).toBeGreaterThanOrEqual(7200);
	}, 30_000);

	test("the encode length limit is the probed length with a margin", () => {
		expect(maxEncodeSeconds(10)).toBe(12);
		expect(maxEncodeSeconds(600)).toBe(612);
		expect(maxEncodeSeconds(0)).toBeNull();
		expect(maxEncodeSeconds(Number.NaN)).toBeNull();
	});
});
