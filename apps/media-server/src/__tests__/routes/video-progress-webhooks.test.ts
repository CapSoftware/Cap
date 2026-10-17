import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import app from "../../app";
import * as jobManager from "../../lib/job-manager";
import { deleteJob, getJob } from "../../lib/job-manager";
import * as mediaVideo from "../../lib/media-video";

const fixture = join(import.meta.dir, "..", "fixtures", "test-with-audio.mp4");
const directory = mkdtempSync(join(tmpdir(), "cap-progress-webhooks-"));
const received: { videoId: string; phase: string; message?: string }[] = [];
const receiver = Bun.serve({
	port: 0,
	async fetch(request) {
		received.push(await request.json());
		return Response.json({ success: true });
	},
});

afterAll(() => {
	receiver.stop(true);
	rmSync(directory, { recursive: true, force: true });
});

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
	for (const spy of spies.splice(0)) spy.mockRestore();
});

async function encodeWithRapidProgress(priority: "normal" | "bulk") {
	const videoId = `progress-${priority}`;
	const input = join(directory, `${priority}-input.mp4`);
	const output = join(directory, `${priority}-output.mp4`);
	copyFileSync(fixture, input);
	copyFileSync(fixture, output);
	spies.push(
		spyOn(jobManager, "canAcceptNewVideoProcess").mockReturnValue(true),
		spyOn(mediaVideo, "downloadVideoToTemp").mockResolvedValue({
			path: input,
			cleanup: async () => {},
		}),
		spyOn(mediaVideo, "processVideo").mockImplementation(
			async (_input, _metadata, _options, onProgress) => {
				for (let step = 1; step <= 40; step++) {
					onProgress?.(step * 2.5, `Encoding: ${step * 2.5}%`);
					await Bun.sleep(60);
				}
				return { path: output, cleanup: async () => {} };
			},
		),
		spyOn(mediaVideo, "uploadFileToS3").mockResolvedValue({}),
	);
	const secret = process.env.MEDIA_SERVER_WEBHOOK_SECRET ?? "test-secret";
	process.env.MEDIA_SERVER_WEBHOOK_SECRET = secret;
	const response = await app.fetch(
		new Request("http://localhost/video/process", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-media-server-secret": secret,
			},
			body: JSON.stringify({
				videoId,
				userId: "progress-test",
				videoUrl: "https://example.com/raw.mp4",
				outputPresignedUrl: "https://example.com/result.mp4",
				webhookUrl: `http://127.0.0.1:${receiver.port}/progress`,
				webhookSecret: secret,
				priority,
			}),
		}),
	);
	expect(response.status).toBe(200);
	const { jobId } = (await response.json()) as { jobId: string };
	const deadline = Date.now() + 15_000;
	while (Date.now() < deadline && getJob(jobId)?.phase !== "complete") {
		await Bun.sleep(20);
	}
	expect(getJob(jobId)?.phase).toBe("complete");
	deleteJob(jobId);
	return received.filter(
		(update) =>
			update.videoId === videoId && update.message?.startsWith("Encoding"),
	).length;
}

describe("encoding progress webhooks", () => {
	test("keeps regular uploads updating every second for the share page", async () => {
		const sent = await encodeWithRapidProgress("normal");
		expect(sent).toBeGreaterThanOrEqual(2);
		expect(sent).toBeLessThanOrEqual(4);
	}, 30_000);

	test("sends bulk imports one update per five seconds", async () => {
		expect(await encodeWithRapidProgress("bulk")).toBe(1);
	}, 30_000);
});
