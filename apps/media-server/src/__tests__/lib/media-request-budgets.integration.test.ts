import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as childProcess from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import app from "../../app";
import { extractAudioStream } from "../../lib/media-audio";
import { withMediaTransfers } from "../../lib/media-transfer";
import { generateThumbnail } from "../../lib/media-video";
import { verifyRecording } from "../../lib/recording-verification";
import { ensureTempDir, getTempDir } from "../../lib/temp-files";

const originalEnv = { ...process.env };
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
	for (const key of [
		"MEDIA_SERVER_WEBHOOK_SECRET",
		"MEDIA_SERVER_ALLOW_PRIVATE_URLS",
		"S3_INTERNAL_ENDPOINT",
		"MEDIA_SERVER_MAX_PLAYLIST_BYTES",
	]) {
		if (originalEnv[key] === undefined) delete process.env[key];
		else process.env[key] = originalEnv[key];
	}
});

function startServer(
	fetch: (request: Request) => Response | Promise<Response>,
) {
	const server = Bun.serve({ port: 0, fetch });
	servers.push(server);
	return server;
}

describe("media request budgets", () => {
	test.each(["input limit", "transfer budget"])(
		"bounds ordinary audio staging with the %s and removes partial files",
		async (limit) => {
			await ensureTempDir();
			const before = await readdir(getTempDir());
			let stagedPath = "";
			let cancelled = false;
			const server = startServer(async () => {
				stagedPath =
					(await readdir(getTempDir())).find(
						(name) => name.startsWith("audio-input-") && !before.includes(name),
					) ?? "";
				return new Response(
					new ReadableStream({
						start(controller) {
							controller.enqueue(new Uint8Array(2048));
						},
						cancel() {
							cancelled = true;
						},
					}),
				);
			});
			const run = () =>
				extractAudioStream(new URL("audio.mp4", server.url).toString(), {
					timeoutMs: 1000,
				});
			if (limit === "input limit") {
				process.env.MEDIA_SERVER_MAX_PLAYLIST_BYTES = "1024";
				await expect(run()).rejects.toThrow("download byte limit");
			} else {
				await expect(withMediaTransfers(1024, run)).rejects.toThrow(
					"transfer budget",
				);
			}
			expect(stagedPath).not.toBe("");
			expect(await readdir(getTempDir())).not.toContain(stagedPath);
			await Bun.sleep(10);
			expect(cancelled).toBe(true);
		},
	);

	test("applies the thumbnail deadline while downloading", async () => {
		const timeout = AbortSignal.timeout.bind(AbortSignal);
		const timer = spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
			timeout(ms === 60_000 ? 30 : ms),
		);
		let requested = false;
		const server = startServer(() => {
			requested = true;
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
					},
				}),
			);
		});
		try {
			await expect(
				generateThumbnail(new URL("video.mp4", server.url).toString(), 5),
			).rejects.toThrow();
			expect(requested).toBe(true);
			expect(timer).toHaveBeenCalledWith(60_000);
		} finally {
			timer.mockRestore();
		}
	}, 1000);

	test("returns JSON URL_NOT_ALLOWED before an audio stream response is sent", async () => {
		process.env.MEDIA_SERVER_WEBHOOK_SECRET = "test-secret";
		process.env.MEDIA_SERVER_ALLOW_PRIVATE_URLS = "false";
		let requested = false;
		const server = startServer(() => {
			requested = true;
			return new Response(null, {
				status: 307,
				headers: { location: "http://169.254.169.254/private" },
			});
		});
		process.env.S3_INTERNAL_ENDPOINT = server.url.toString();
		const response = await app.fetch(
			new Request("http://localhost/audio/convert", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-media-server-secret": "test-secret",
				},
				body: JSON.stringify({
					audioUrl: new URL("audio.mp4", server.url).toString(),
				}),
			}),
		);
		expect(requested).toBe(true);
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ code: "URL_NOT_ALLOWED" });
	});

	test("accounts for remote verification staging in the managed temp directory and removes it on timeout", async () => {
		await ensureTempDir();
		const before = await readdir(getTempDir());
		let managedPath = "";
		const server = startServer(async () => {
			managedPath =
				(await readdir(getTempDir())).find(
					(name) => name.startsWith("recording-") && !before.includes(name),
				) ?? "";
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new Uint8Array([1]));
					},
				}),
			);
		});
		await expect(
			verifyRecording(new URL("recording.mp4", server.url).toString(), {
				allowObservedDuration: true,
				requireAudio: false,
				timeoutMs: 100,
			}),
		).rejects.toThrow("timed out");
		expect(managedPath).not.toBe("");
		expect(await readdir(getTempDir())).not.toContain(managedPath);
	});

	test("shares the recording deadline between staging and decode", async () => {
		const bytes = await readFile(
			join(import.meta.dir, "../fixtures/test-with-audio.mp4"),
		);
		const server = startServer(async () => {
			await new Promise((resolve) => setTimeout(resolve, 300));
			return new Response(bytes);
		});
		const originalSpawn = childProcess.spawn;
		const decoder = spyOn(childProcess, "spawn").mockImplementation(((
			...args: Parameters<typeof childProcess.spawn>
		) =>
			originalSpawn(
				process.execPath,
				["-e", "setTimeout(() => {}, 2000)"],
				args[2],
			)) as typeof childProcess.spawn);
		const startedAt = performance.now();
		try {
			await expect(
				verifyRecording(new URL("recording.mp4", server.url).toString(), {
					allowObservedDuration: true,
					requireAudio: false,
					hasAudio: false,
					timeoutMs: 500,
				}),
			).rejects.toThrow("timed out");
			expect(decoder).toHaveBeenCalledTimes(1);
			expect(performance.now() - startedAt).toBeLessThan(700);
		} finally {
			decoder.mockRestore();
		}
	}, 1500);

	test("enforces the transfer budget on non-internal recording URLs", async () => {
		const bytes = await readFile(
			join(import.meta.dir, "../fixtures/test-with-audio.mp4"),
		);
		const server = startServer(() => new Response(bytes));
		await expect(
			withMediaTransfers(1024, () =>
				verifyRecording(new URL("recording.mp4", server.url).toString(), {
					allowObservedDuration: true,
					requireAudio: false,
				}),
			),
		).rejects.toThrow("transfer budget");
	});
});
