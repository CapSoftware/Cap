import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matroskaEndFromTail } from "../../lib/matroska-tail";
import { encodeLengthLimit } from "../../lib/media-common";
import {
	probeVideo,
	UNFINISHED_RECORDING_MESSAGE,
} from "../../lib/media-probe";
import { stopProbeWorkers } from "../../lib/media-probe-pool";

const SPARSE_BYTES = 800 * 1024 * 1024;
const LOOPS = 60;
// What a read of a remote file over a real network does in a second. Reads
// that run from an offset to the end are held to it.
const OPEN_ENDED_BYTES_PER_SECOND = 4 * 1024 * 1024;

let dir = "";
let server: ReturnType<typeof Bun.serve>;
let origin = "";
const served = new Map<string, number>();

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	if (code !== 0) throw new Error(stderr);
	return stdout;
}

// The time of the last video packet, as FFmpeg reads it.
async function lastPacketTime(path: string): Promise<number> {
	const lines = (
		await run([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_entries",
			"packet=pts_time",
			"-of",
			"csv=p=0",
			path,
		])
	)
		.split("\n")
		.map(Number.parseFloat)
		.filter(Number.isFinite);
	return Math.max(...lines);
}

function slowStream(file: Blob, start: number): ReadableStream<Uint8Array> {
	let offset = start;
	const chunk = 256 * 1024;
	return new ReadableStream({
		async pull(controller) {
			if (offset >= file.size) return controller.close();
			const bytes = new Uint8Array(
				await file.slice(offset, offset + chunk).arrayBuffer(),
			);
			offset += bytes.length;
			await Bun.sleep((bytes.length / OPEN_ENDED_BYTES_PER_SECOND) * 1000);
			controller.enqueue(bytes);
		},
	});
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "matroska-length-"));
	const video = ["-f", "lavfi", "-i", "testsrc2=d=60:s=160x90:r=30"];
	const audio = ["-f", "lavfi", "-i", "sine=d=60"];
	// FFmpeg writing to a pipe cannot go back to write Cues or a Duration.
	await run([
		"sh",
		"-c",
		`ffmpeg -v error ${[...video, ...audio].join(" ")} -c:v libx264 -preset ultrafast -c:a aac -f matroska - > "${join(dir, "piped.mkv")}"`,
	]);
	await run([
		"sh",
		"-c",
		`ffmpeg -v error ${[...video, ...audio].join(" ")} -c:v libvpx -deadline realtime -cpu-used 8 -c:a libopus -f webm -live 1 - > "${join(dir, "recorder.webm")}"`,
	]);

	// What production saw: a short recording looped into a long one with
	// stream copy into a pipe, so no Cues and no Duration.
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=d=6:s=640x360:r=30",
		"-f",
		"lavfi",
		"-i",
		"sine=d=6",
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-b:v",
		"8M",
		"-c:a",
		"aac",
		"-y",
		join(dir, "base.mkv"),
	]);
	await run([
		"sh",
		"-c",
		`ffmpeg -v error -stream_loop ${LOOPS - 1} -i "${join(dir, "base.mkv")}" -c copy -f matroska - > "${join(dir, "looped.mkv")}"`,
	]);

	// The head and tail of the piped file around 800 MB of nothing: a file
	// only a bounded read can measure in time.
	const pipedBytes = await readFile(join(dir, "piped.mkv"));
	const headBytes = pipedBytes.subarray(0, 1024 * 1024);
	const tailBytes = pipedBytes.subarray(pipedBytes.length - 1024 * 1024);
	const sparse = await open(join(dir, "sparse.mkv"), "w");
	await sparse.write(headBytes, 0, headBytes.length, 0);
	await sparse.write(
		tailBytes,
		0,
		tailBytes.length,
		SPARSE_BYTES - tailBytes.length,
	);
	await sparse.close();

	// A recording cut off with no cluster anywhere near its end.
	await writeFile(
		join(dir, "no-tail.mkv"),
		Buffer.concat([headBytes, Buffer.alloc(40 * 1024 * 1024)]),
	);

	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const name = new URL(request.url).pathname.slice(1);
			const file = Bun.file(join(dir, name));
			const size = file.size;
			const range = request.headers.get("range") ?? "";
			let start = 0;
			let end = size - 1;
			const suffix = range.match(/^bytes=-(\d+)$/);
			const span = range.match(/^bytes=(\d+)-(\d*)$/);
			if (suffix) start = Math.max(0, size - Number(suffix[1]));
			else if (span) {
				start = Number(span[1]);
				if (span[2]) end = Math.min(Number(span[2]), size - 1);
			}
			if (start >= size)
				return new Response(null, {
					status: 416,
					headers: { "Content-Range": `bytes */${size}` },
				});
			const length = end - start + 1;
			const openEnded = span !== null && !span[2];
			served.set(name, (served.get(name) ?? 0) + (openEnded ? 0 : length));
			return new Response(
				openEnded ? slowStream(file, start) : file.slice(start, end + 1),
				{
					status: range ? 206 : 200,
					headers: {
						"Accept-Ranges": "bytes",
						"Content-Length": String(length),
						"Content-Range": `bytes ${start}-${end}/${size}`,
					},
				},
			);
		},
	});
	origin = `http://127.0.0.1:${server.port}`;
}, 120_000);

afterAll(async () => {
	stopProbeWorkers();
	await server.stop(true);
	await rm(dir, { recursive: true, force: true });
});

describe("the length of a Matroska file with no Duration and no Cues", () => {
	test.each(["piped.mkv", "recorder.webm"])(
		"%s is read from its tail, locally and over HTTP ranges",
		async (name) => {
			const expected = await lastPacketTime(join(dir, name));
			expect(expected).toBeGreaterThan(59);
			const local = await matroskaEndFromTail(join(dir, name));
			expect(Math.abs((local ?? 0) - expected)).toBeLessThan(1);
			served.delete(name);
			const remote = await matroskaEndFromTail(`${origin}/${name}`);
			expect(Math.abs((remote ?? 0) - expected)).toBeLessThan(1);
		},
		60_000,
	);

	test("a file hundreds of megabytes long is measured from two small reads", async () => {
		served.delete("sparse.mkv");
		const started = performance.now();
		const end = await matroskaEndFromTail(`${origin}/sparse.mkv`);
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(
			Math.abs((end ?? 0) - (await lastPacketTime(join(dir, "piped.mkv")))),
		).toBeLessThan(1);
		expect(served.get("sparse.mkv") ?? 0).toBeLessThanOrEqual(
			64 * 1024 + 4 * 1024 * 1024,
		);
	}, 60_000);

	test("the probe reports it through the probe workers and holds encodes to it", async () => {
		expect(Bun.file(join(dir, "looped.mkv")).size).toBeGreaterThan(
			150 * 1024 * 1024,
		);
		const started = performance.now();
		// At this rate a full read of the file takes far longer than a probe.
		const metadata = await probeVideo(`${origin}/looped.mkv`);
		expect(performance.now() - started).toBeLessThan(15_000);
		const expected = await lastPacketTime(join(dir, "looped.mkv"));
		expect(expected).toBeGreaterThan(LOOPS * 6 - 2);
		expect(Math.abs(metadata.duration - expected)).toBeLessThan(1);
		expect(Math.abs((metadata.timestampSpan ?? 0) - expected)).toBeLessThan(1);
		expect(encodeLengthLimit(metadata)).toBeGreaterThanOrEqual(expected);
	}, 60_000);

	test("a file whose end holds no cluster is refused as unfinished, not timed out", async () => {
		const started = performance.now();
		const error = await probeVideo(`${origin}/no-tail.mkv`).then(
			() => null,
			(caught: unknown) => caught,
		);
		expect((error as Error)?.message).toBe(UNFINISHED_RECORDING_MESSAGE);
		expect(performance.now() - started).toBeLessThan(5_000);
	}, 60_000);
});
