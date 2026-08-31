import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	isRetryableRecordingVerificationError,
	verifyRecording,
	verifyRemoteRecording,
} from "../../lib/recording-verification";

const FIXTURES = join(import.meta.dir, "..", "fixtures");
let directory: string;
let silent: string;
let shortAudio: string;
let corruptTail: string;
let truncatedTail: string;
let audioGap: string;
let variableFrameRate: string;
let silentBytes: Uint8Array<ArrayBuffer>;
let corruptBytes: Uint8Array<ArrayBuffer>;

async function run(command: string[]): Promise<string> {
	const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
	const [output, error, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) throw new Error(error);
	return output;
}

async function generate(path: string, audio: string, filters: string[] = []) {
	await run([
		"ffmpeg",
		"-v",
		"error",
		"-f",
		"lavfi",
		"-i",
		"testsrc2=size=320x180:rate=30:duration=5",
		"-f",
		"lavfi",
		"-i",
		audio,
		...filters,
		"-c:v",
		"libx264",
		"-preset",
		"ultrafast",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-movflags",
		"+faststart",
		path,
	]);
}

beforeAll(async () => {
	directory = await mkdtemp(join(tmpdir(), "cap-recording-verification-"));
	silent = join(directory, "silent.mp4");
	shortAudio = join(directory, "short-audio.mp4");
	audioGap = join(directory, "audio-gap.mp4");
	variableFrameRate = join(directory, "variable-frame-rate.mp4");
	corruptTail = join(directory, "corrupt-tail.mp4");
	truncatedTail = join(directory, "truncated-tail.mp4");
	await generate(silent, "anullsrc=r=48000:cl=mono:d=5");
	await generate(
		shortAudio,
		"sine=frequency=700:sample_rate=48000:duration=0.1",
	);
	await generate(audioGap, "sine=frequency=700:sample_rate=48000:duration=4", [
		"-af",
		"asetpts=PTS+if(gte(T\\,2)\\,1/TB\\,0)",
	]);
	await generate(variableFrameRate, "anullsrc=r=48000:cl=mono:d=5", [
		"-vf",
		"select=not(mod(n\\,3))+not(mod(n\\,5))",
		"-fps_mode",
		"vfr",
		"-video_track_timescale",
		"90000",
	]);
	silentBytes = new Uint8Array(await readFile(silent));
	const packets: {
		packets: { pos: string; size: string; pts_time: string }[];
	} = JSON.parse(
		await run([
			"ffprobe",
			"-v",
			"error",
			"-select_streams",
			"v:0",
			"-show_packets",
			"-show_entries",
			"packet=pos,size,pts_time",
			"-of",
			"json",
			silent,
		]),
	);
	const last = packets.packets.at(-1);
	if (!last || Number(last.pts_time) < 4.5) {
		throw new Error("Fault fixture has no late video packet");
	}
	const damaged = silentBytes.slice();
	damaged.fill(0, Number(last.pos), Number(last.pos) + Number(last.size));
	corruptBytes = damaged;
	await writeFile(corruptTail, damaged);
	await writeFile(
		truncatedTail,
		silentBytes.subarray(0, Math.floor(silentBytes.length * 0.9)),
	);
}, 30_000);

afterAll(async () => {
	if (directory) await rm(directory, { recursive: true, force: true });
});

describe("complete recording decode", () => {
	test("counts real decoded frames and samples, including valid silent audio", async () => {
		const evidence = await verifyRecording(silent, {
			expectedDuration: 5,
			requireAudio: true,
		});
		expect(evidence.fullDecode).toBe(true);
		expect(evidence.video.frameCount).toBe(150);
		expect(evidence.video.duration).toBeCloseTo(5, 3);
		expect(evidence.audio?.sampleCount).toBeGreaterThanOrEqual(240_000);
		expect(evidence.audio?.sampleRate).toBe(48_000);
		expect(evidence.audio?.decodedDuration).toBeCloseTo(5, 1);
	});

	test("accepts legacy video without audio only when audio was not requested", async () => {
		const input = join(FIXTURES, "test-no-audio.mp4");
		const evidence = await verifyRecording(input, {
			expectedDuration: 1,
			requireAudio: false,
		});
		expect(evidence.video.frameCount).toBe(25);
		expect(evidence.audio).toBeNull();
		await expect(
			verifyRecording(input, { expectedDuration: 1, requireAudio: true }),
		).rejects.toThrow("missing required audio coverage");
	});

	test("preserves the source timebase for variable frame rate video", async () => {
		const evidence = await verifyRecording(variableFrameRate, {
			expectedDuration: 5,
			requireAudio: true,
		});
		expect(evidence.video.frameCount).toBe(70);
		expect(evidence.video.duration).toBeGreaterThan(4.8);
	});

	test.each(["corrupt", "truncated"])(
		"rejects a %s tail even with a readable complete-duration header",
		async (damage) => {
			const input = damage === "corrupt" ? corruptTail : truncatedTail;
			const header = await run([
				"ffprobe",
				"-v",
				"error",
				"-show_entries",
				"format=duration",
				"-of",
				"json",
				input,
			]);
			expect(Number(JSON.parse(header).format.duration)).toBe(5);
			const error = await verifyRecording(input, {
				expectedDuration: 5,
				requireAudio: true,
			}).catch((error: unknown) => error);
			expect(error).toBeInstanceOf(Error);
			expect((error as Error).message).toContain(
				"Recording full decode failed",
			);
			expect(isRetryableRecordingVerificationError(error)).toBe(false);
		},
	);

	test("rejects a readable short audio track and a missing middle interval", async () => {
		for (const input of [shortAudio, audioGap]) {
			await expect(
				verifyRecording(input, { expectedDuration: 5, requireAudio: true }),
			).rejects.toThrow("missing required audio coverage");
		}
	});

	test("rejects a completely decodable video that is shorter than expected", async () => {
		await expect(
			verifyRecording(join(FIXTURES, "test-with-audio.mp4"), {
				expectedDuration: 5,
				requireAudio: true,
			}),
		).rejects.toThrow("does not cover its expected duration");
	});

	test("does not follow local symlinks", async () => {
		const link = join(directory, "linked.mp4");
		await symlink(silent, link);
		await expect(
			verifyRecording(link, { expectedDuration: 5, requireAudio: true }),
		).rejects.toThrow("regular MP4 file");
	});
});

async function decoderPids(input: string): Promise<number[]> {
	if (process.platform === "linux") {
		const processes = (await readdir("/proc")).filter((name) =>
			/^\d+$/.test(name),
		);
		const matches = await Promise.all(
			processes.map(async (pid) => {
				try {
					const command = await readFile(`/proc/${pid}/cmdline`, "utf8");
					return command.includes("ffmpeg") && command.includes(input)
						? Number(pid)
						: null;
				} catch (error) {
					if (
						error instanceof Error &&
						"code" in error &&
						(error.code === "ENOENT" || error.code === "ESRCH")
					)
						return null;
					throw error;
				}
			}),
		);
		return matches.filter((pid): pid is number => pid !== null);
	}
	const output = await run(["ps", "-axo", "pid=,command="]);
	return output
		.split("\n")
		.filter((line) => line.includes("ffmpeg") && line.includes(input))
		.map((line) => Number.parseInt(line.trim(), 10));
}

function expectExited(pid: number) {
	expect(() => process.kill(pid, 0)).toThrow();
}

describe("recording verification lifetime", () => {
	test("does not start work for an already cancelled request", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			verifyRecording(silent, {
				expectedDuration: 5,
				requireAudio: true,
				abortSignal: controller.signal,
			}),
		).rejects.toThrow("cancelled");
	});

	test.each(["cancel", "timeout"])(
		"joins its real decoder after %s while the input is stalled",
		async (cause) => {
			let received: (() => void) | undefined;
			const request = new Promise<void>((resolve) => {
				received = resolve;
			});
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch() {
					received?.();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(silentBytes.subarray(0, 16_384));
							},
						}),
						{ headers: { "Content-Type": "video/mp4" } },
					);
				},
			});
			const controller = new AbortController();
			const input = `http://127.0.0.1:${server.port}/${crypto.randomUUID()}.mp4`;
			try {
				const outcome = verifyRecording(input, {
					expectedDuration: 5,
					requireAudio: true,
					abortSignal: controller.signal,
					timeoutMs: cause === "timeout" ? 1_000 : 5_000,
				}).then(
					() => new Error("Unexpected successful verification"),
					(error: unknown) => error,
				);
				await request;
				const pids = await decoderPids(input);
				expect(pids.length).toBe(1);
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				for (const pid of pids) expectExited(pid);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
		10_000,
	);

	test("decodes remote output and never includes signed query values in failures", async () => {
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				return new URL(request.url).pathname === "/valid.mp4"
					? new Response(silentBytes, {
							headers: { "Content-Type": "video/mp4" },
						})
					: new Response("Missing", { status: 404 });
			},
		});
		try {
			const evidence = await verifyRecording(
				`http://127.0.0.1:${server.port}/valid.mp4`,
				{ expectedDuration: 5, requireAudio: true },
			);
			expect(evidence.video.frameCount).toBe(150);
			const result = await verifyRecording(
				`http://127.0.0.1:${server.port}/missing.mp4?signature=private-value`,
				{ expectedDuration: 5, requireAudio: true },
			).catch((error: unknown) => error);
			expect(result).toBeInstanceOf(Error);
			expect((result as Error).message).not.toContain("private-value");
		} finally {
			await server.stop(true);
		}
	});
});

function objectResponse(
	request: Request,
	identity?: string,
	honorCondition = true,
	bytes = silentBytes,
) {
	if (
		honorCondition &&
		request.headers.has("if-match") &&
		request.headers.get("if-match") !== identity
	) {
		return new Response("Object changed", { status: 412 });
	}
	const headers: Record<string, string> = {
		"Content-Type": "video/mp4",
	};
	if (identity !== undefined) headers.ETag = identity;
	if (request.headers.get("range") === "bytes=0-0") {
		headers["Content-Range"] = `bytes 0-0/${bytes.byteLength}`;
		return new Response(bytes.subarray(0, 1), { status: 206, headers });
	}
	return new Response(bytes, { headers });
}

describe("remote recording object identity", () => {
	test("binds the decode and receipt to a strong opaque object version", async () => {
		const requests: { match: string | null; optIn: string | null }[] = [];
		const identity = '"drive-file:42"';
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch(request) {
				requests.push({
					match: request.headers.get("if-match"),
					optIn: request.headers.get("x-cap-recording-verification"),
				});
				return objectResponse(request, identity);
			},
		});
		try {
			const evidence = await verifyRemoteRecording(
				`http://127.0.0.1:${server.port}/recording.mp4`,
				{
					expectedDuration: 5,
					requireAudio: true,
					expectedObjectIdentity: identity,
				},
			);
			expect(evidence.fullDecode).toBe(true);
			expect(evidence.video.frameCount).toBe(150);
			expect(evidence.objectIdentity).toBe(identity);
			expect(evidence.fileSize).toBe(silentBytes.byteLength);
			expect(requests.length).toBeGreaterThanOrEqual(3);
			expect(requests.every((request) => request.match === identity)).toBe(
				true,
			);
			expect(requests.every((request) => request.optIn === "1")).toBe(true);
		} finally {
			await server.stop(true);
		}
	});

	test.each([undefined, 'W/"weak-version"'])(
		"refuses a missing or weak object identity (%s) before decoding",
		async (identity) => {
			let decoderRequests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.get("range") !== "bytes=0-0") decoderRequests++;
					return objectResponse(request, identity);
				},
			});
			try {
				await expect(
					verifyRemoteRecording(
						`http://127.0.0.1:${server.port}/recording.mp4`,
						{
							expectedDuration: 5,
							requireAudio: true,
						},
					),
				).rejects.toThrow("does not expose a strong object identity");
				expect(decoderRequests).toBe(0);
			} finally {
				await server.stop(true);
			}
		},
	);

	test.each(["before-decode", "after-decode", "ignored-condition"])(
		"rejects same-size corrupt replacement of a valid object (%s)",
		async (when) => {
			let probes = 0;
			let decoderRequests = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					const probe = request.headers.get("range") === "bytes=0-0";
					if (probe) probes++;
					else decoderRequests++;
					const changed = probes > 1 || (when === "before-decode" && !probe);
					return objectResponse(
						request,
						changed ? '"new-version"' : '"original-version"',
						when !== "ignored-condition",
						changed ? corruptBytes : silentBytes,
					);
				},
			});
			try {
				const error = await verifyRemoteRecording(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{ expectedDuration: 5, requireAudio: true },
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					when === "before-decode" ? "full decode failed" : "object changed",
				);
				expect(isRetryableRecordingVerificationError(error)).toBe(false);
				expect(decoderRequests).toBeGreaterThan(0);
				if (when !== "before-decode") expect(probes).toBe(2);
			} finally {
				await server.stop(true);
			}
		},
	);

	test.each(["cancel", "timeout"])(
		"keeps decoder cleanup effective across remote identity checks on %s",
		async (cause) => {
			let started: (() => void) | undefined;
			const decoding = new Promise<void>((resolve) => {
				started = resolve;
			});
			let probes = 0;
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (request.headers.get("range") === "bytes=0-0") {
						probes++;
						return objectResponse(request, '"original-version"');
					}
					started?.();
					return new Response(
						new ReadableStream({
							start(controller) {
								controller.enqueue(silentBytes.subarray(0, 16_384));
							},
						}),
						{ headers: { "Content-Type": "video/mp4" } },
					);
				},
			});
			const controller = new AbortController();
			const input = `http://127.0.0.1:${server.port}/${crypto.randomUUID()}.mp4`;
			try {
				const outcome = verifyRemoteRecording(input, {
					expectedDuration: 5,
					requireAudio: true,
					abortSignal: controller.signal,
					timeoutMs: cause === "timeout" ? 1_000 : 5_000,
				}).then(
					() => new Error("Unexpected successful verification"),
					(error: unknown) => error,
				);
				await decoding;
				const pids = await decoderPids(input);
				expect(pids.length).toBe(1);
				if (cause === "cancel") controller.abort();
				const error = await outcome;
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toContain(
					cause === "cancel" ? "cancelled" : "timed out",
				);
				expect(probes).toBe(1);
				expect(isRetryableRecordingVerificationError(error)).toBe(
					cause === "timeout",
				);
				for (const pid of pids) expectExited(pid);
			} finally {
				controller.abort();
				await server.stop(true);
			}
		},
		10_000,
	);

	test.each(["identity-read", "decoder-read"])(
		"classifies HTTP503 during %s as retryable without a receipt",
		async (stage) => {
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				fetch(request) {
					if (
						stage === "identity-read" ||
						request.headers.get("range") !== "bytes=0-0"
					) {
						return new Response("Unavailable", { status: 503 });
					}
					return objectResponse(request, '"original-version"');
				},
			});
			try {
				const error = await verifyRemoteRecording(
					`http://127.0.0.1:${server.port}/recording.mp4`,
					{ expectedDuration: 5, requireAudio: true },
				).catch((error: unknown) => error);
				expect(error).toBeInstanceOf(Error);
				expect(isRetryableRecordingVerificationError(error)).toBe(true);
			} finally {
				await server.stop(true);
			}
		},
	);
});
