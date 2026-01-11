import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";
import { getActiveProcessCount } from "../../lib/ffmpeg";

const FIXTURES_DIR = join(import.meta.dir, "..", "fixtures");
const TEST_VIDEO_WITH_AUDIO = `file://${join(FIXTURES_DIR, "test-with-audio.mp4")}`;

async function waitForProcessCleanup(
	expectedCount: number,
	timeoutMs = 5000,
): Promise<void> {
	const startTime = Date.now();
	while (Date.now() - startTime < timeoutMs) {
		if (getActiveProcessCount() === expectedCount) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw new Error(
		`Timeout waiting for process count to reach ${expectedCount}, got ${getActiveProcessCount()}`,
	);
}

async function getFreshApp() {
	mock.restore();
	const { default: freshApp } = await import("../../app");
	return freshApp;
}

describe("audio routes memory management", () => {
	let initialProcessCount: number;

	beforeEach(() => {
		mock.restore();
		initialProcessCount = getActiveProcessCount();
	});

	afterEach(async () => {
		await waitForProcessCleanup(initialProcessCount, 10000);
	});

	describe("POST /audio/check", () => {
		test("cleans up after successful check", async () => {
			const app = await getFreshApp();
			const response = await app.fetch(
				new Request("http://localhost/audio/check", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ videoUrl: TEST_VIDEO_WITH_AUDIO }),
				}),
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(data.hasAudio).toBe(true);

			await waitForProcessCleanup(initialProcessCount);
		});

		test("cleans up after multiple concurrent checks", async () => {
			const app = await getFreshApp();
			const requests = Array.from({ length: 5 }, () =>
				app.fetch(
					new Request("http://localhost/audio/check", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ videoUrl: TEST_VIDEO_WITH_AUDIO }),
					}),
				),
			);

			const responses = await Promise.all(requests);

			for (const response of responses) {
				expect(response.status).toBe(200);
				await response.json();
			}

			await waitForProcessCleanup(initialProcessCount);
		});
	});

	describe("POST /audio/extract (streaming)", () => {
		test("cleans up after stream is fully consumed", async () => {
			const app = await getFreshApp();
			const response = await app.fetch(
				new Request("http://localhost/audio/extract", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoUrl: TEST_VIDEO_WITH_AUDIO,
						stream: true,
					}),
				}),
			);

			expect(response.status).toBe(200);

			const reader = response.body!.getReader();
			while (true) {
				const { done } = await reader.read();
				if (done) break;
			}
			reader.releaseLock();

			await waitForProcessCleanup(initialProcessCount);
		});

		test("cleans up when stream is cancelled early", async () => {
			const app = await getFreshApp();
			const response = await app.fetch(
				new Request("http://localhost/audio/extract", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoUrl: TEST_VIDEO_WITH_AUDIO,
						stream: true,
					}),
				}),
			);

			expect(response.status).toBe(200);

			const reader = response.body!.getReader();
			await reader.read();
			await reader.cancel();

			await waitForProcessCleanup(initialProcessCount);
		});

		test("cleans up when response body is not read at all", async () => {
			const app = await getFreshApp();
			const response = await app.fetch(
				new Request("http://localhost/audio/extract", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoUrl: TEST_VIDEO_WITH_AUDIO,
						stream: true,
					}),
				}),
			);

			expect(response.status).toBe(200);

			await response.body?.cancel();

			await waitForProcessCleanup(initialProcessCount, 15000);
		});

		test("cleans up with multiple concurrent streaming requests", async () => {
			const app = await getFreshApp();
			const requests = Array.from({ length: 3 }, () =>
				app.fetch(
					new Request("http://localhost/audio/extract", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							videoUrl: TEST_VIDEO_WITH_AUDIO,
							stream: true,
						}),
					}),
				),
			);

			const responses = await Promise.all(requests);

			for (const response of responses) {
				expect(response.status).toBe(200);
				const reader = response.body!.getReader();
				while (true) {
					const { done } = await reader.read();
					if (done) break;
				}
				reader.releaseLock();
			}

			await waitForProcessCleanup(initialProcessCount);
		});
	});

	describe("status endpoint", () => {
		test("reports accurate process count", async () => {
			const app = await getFreshApp();
			const response = await app.fetch(
				new Request("http://localhost/audio/status", {
					method: "GET",
				}),
			);

			expect(response.status).toBe(200);
			const data = await response.json();
			expect(typeof data.activeProcesses).toBe("number");
			expect(typeof data.canAcceptNewProcess).toBe("boolean");
			expect(data.activeProcesses).toBe(initialProcessCount);
		});
	});
});
