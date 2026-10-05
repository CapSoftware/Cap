import { expect, test } from "bun:test";
import {
	mediaConnectionSample,
	openConnectionWindow,
	startMediaRead,
} from "./browser-network-budget";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/// One media read: `delayMs` before its response, then `chunks` of 64 KB that
/// the reader takes `readGapMs` apart.
async function read(delayMs: number, chunks: number, readGapMs = 0) {
	const media = startMediaRead();
	await sleep(delayMs);
	const chunk = new Uint8Array(64 * 1024);
	let sent = 0;
	const body = media.body(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ === chunks) controller.close();
				else controller.enqueue(chunk);
			},
		}),
	);
	const reader = body.getReader();
	while (!(await reader.read()).done) if (readGapMs) await sleep(readGapMs);
}

test("ignores the editor's startup reads until the window opens", async () => {
	await read(5, 20);
	await read(5, 20);
	const before = mediaConnectionSample();
	expect(before.bitsPerSecond).toBeNull();
	expect(before.latencyMs).toBeNull();
	expect(before.evidence).toEqual({
		reads: 0,
		bytes: 0,
		waitedMs: 0,
		ageMs: 0,
	});
	// Kept apart as startup evidence instead.
	expect(before.startup.evidence.reads).toBe(2);
	expect(before.startup.evidence.bytes).toBe(40 * 64 * 1024);
	expect(before.startup.latencyMs).toBeGreaterThanOrEqual(4);
	expect(before.startup.bitsPerSecond).not.toBeNull();

	// A read already waiting for its response when the window opens counts
	// neither its response time nor itself.
	const straddling = read(60, 2);
	await sleep(20);
	openConnectionWindow();
	await straddling;
	expect(mediaConnectionSample().evidence.reads).toBe(0);
	expect(mediaConnectionSample().latencyMs).toBeNull();

	await read(30, 4);
	const after = mediaConnectionSample();
	expect(after.startup.evidence.reads).toBe(2);
	expect(after.evidence.reads).toBe(1);
	expect(after.latencyMs).toBeGreaterThanOrEqual(25);
	expect(after.evidence.ageMs).toBeGreaterThanOrEqual(60);
});

test("rates the connection by time spent waiting on it, not on the reader", async () => {
	openConnectionWindow();
	// A reader that takes its time between chunks: the connection had them
	// ready, so it isn't the connection that was slow.
	await read(40, 6, 60);
	const sample = mediaConnectionSample();
	expect(sample.latencyMs).toBeGreaterThanOrEqual(35);
	expect(sample.evidence.bytes).toBe(6 * 64 * 1024);
	expect(sample.bitsPerSecond).not.toBeNull();
	expect(sample.bitsPerSecond ?? 0).toBeGreaterThan(50_000_000);
});

test("times startup by the wall clock, so a busy editor can't make it look fast", async () => {
	// A second copy of the module, so startup hasn't closed for it yet.
	const specifier = "./browser-network-budget.ts?startup-clock";
	const fresh = (await import(
		specifier
	)) as typeof import("./browser-network-budget");
	// Three reads of 256 KB whose reader is slow to pull, as an editor busy
	// starting up is: chunks wait for it, not it for them. By waiting time
	// this link is very fast; by the wall clock it delivered about 768 KB in
	// about half a second.
	for (let index = 0; index < 3; index++) {
		const media = fresh.startMediaRead();
		const chunk = new Uint8Array(64 * 1024);
		let sent = 0;
		const reader = media
			.body(
				new ReadableStream<Uint8Array>({
					pull(controller) {
						if (sent++ === 4) controller.close();
						else controller.enqueue(chunk);
					},
				}),
			)
			.getReader();
		while (!(await reader.read()).done) await sleep(40);
	}
	const startup = fresh.mediaConnectionSample().startup;
	expect(startup.evidence.reads).toBe(3);
	expect(startup.evidence.bytes).toBe(3 * 4 * 64 * 1024);
	expect(startup.evidence.waitedMs).toBeLessThan(100);
	expect(startup.bitsPerSecond ?? 0).toBeGreaterThan(5_000_000);
	expect(startup.bitsPerSecond ?? 0).toBeLessThan(25_000_000);
});
