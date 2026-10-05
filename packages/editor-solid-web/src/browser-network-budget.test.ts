import { expect, test } from "bun:test";
import {
	mediaConnectionSample,
	startMediaRead,
} from "./browser-network-budget";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("rates the connection by time spent waiting on it, not on the reader", async () => {
	expect(mediaConnectionSample()).toEqual({
		bitsPerSecond: null,
		latencyMs: null,
	});
	const read = startMediaRead();
	await sleep(40);
	const chunk = new Uint8Array(64 * 1024);
	let sent = 0;
	const body = read.body(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ === 6) controller.close();
				else controller.enqueue(chunk);
			},
		}),
	);
	const reader = body.getReader();
	// A reader that takes its time between chunks: the connection had them
	// ready, so it isn't the connection that was slow.
	while (!(await reader.read()).done) await sleep(60);
	const sample = mediaConnectionSample();
	expect(sample.latencyMs).toBeGreaterThanOrEqual(35);
	expect(sample.bitsPerSecond).not.toBeNull();
	expect(sample.bitsPerSecond ?? 0).toBeGreaterThan(50_000_000);
});
