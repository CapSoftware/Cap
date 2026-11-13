import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeVideoFile } from "../../lib/media-probe";
import { stopProbeWorkers } from "../../lib/media-probe-pool";
import { colourProbeIsOptional, processVideo } from "../../lib/media-video";

let dir = "";
const savedPath = process.env.PATH;

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

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "colour-probe-"));
	const source = ["-f", "lavfi", "-i", "testsrc=d=0.5:s=128x96:r=10"];
	await ffmpeg([...source, "-c:v", "libvpx-vp9", join(dir, "browser.webm")]);
	await ffmpeg([...source, "-c:v", "libx265", join(dir, "phone.mp4")]);
	// An ffprobe that cannot answer the colour question and answers the rest.
	const real = Bun.which("ffprobe");
	const shim = join(dir, "bin");
	await Bun.write(
		join(shim, "ffprobe"),
		`#!/bin/sh\ncase "$*" in *color_transfer*) exit 1 ;; esac\nexec "${real}" "$@"\n`,
	);
	await chmod(join(shim, "ffprobe"), 0o755);
	await writeFile(join(dir, "marker"), "");
	process.env.PATH = `${shim}:${savedPath}`;
}, 60_000);

afterAll(async () => {
	process.env.PATH = savedPath;
	stopProbeWorkers();
	await rm(dir, { recursive: true, force: true });
});

describe("colour information that cannot be read", () => {
	test("only VP8 and VP9 may go without it", () => {
		expect(colourProbeIsOptional("vp8")).toBe(true);
		expect(colourProbeIsOptional("vp9")).toBe(true);
		for (const codec of ["hevc", "av1", "h264", "prores", "unknown"])
			expect(colourProbeIsOptional(codec)).toBe(false);
	});

	test("a VP9 browser recording is encoded as standard range", async () => {
		const path = join(dir, "browser.webm");
		const metadata = await probeVideoFile(path);
		expect(metadata.videoCodec).toBe("vp9");
		const output = await processVideo(path, metadata, {});
		try {
			expect(Bun.file(output.path).size).toBeGreaterThan(0);
		} finally {
			await output.cleanup();
		}
	}, 60_000);

	test("an HEVC source still fails rather than guess standard range", async () => {
		const path = join(dir, "phone.mp4");
		const metadata = await probeVideoFile(path);
		expect(metadata.videoCodec).toBe("hevc");
		expect(processVideo(path, metadata, {})).rejects.toThrow(
			"Could not read the colour information",
		);
	}, 60_000);
});
