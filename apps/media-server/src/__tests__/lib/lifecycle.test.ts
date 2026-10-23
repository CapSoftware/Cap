import { afterEach, describe, expect, test } from "bun:test";
import {
	beginRequest,
	createShutdownHandler,
	getDrainBlockers,
	getIdleTimeoutSeconds,
	getShutdownGraceMs,
	isDraining,
	isIdle,
	restoreIdleTimeoutOnFirstChunk,
	setDraining,
	setRequestIdleTimeout,
	trackBackgroundTask,
	waitForDrain,
} from "../../lib/lifecycle";

const originalGrace = process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS;
const originalIdle = process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS;

function deferred() {
	let resolve = () => {};
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

afterEach(() => {
	setDraining(false);
	if (originalGrace === undefined)
		delete process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS;
	else process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS = originalGrace;
	if (originalIdle === undefined)
		delete process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS;
	else process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS = originalIdle;
});

describe("shutdown configuration", () => {
	test("defaults to the immediate shutdown path", () => {
		delete process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS;
		expect(getShutdownGraceMs()).toBe(0);
		process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS = "not-a-number";
		expect(getShutdownGraceMs()).toBe(0);
		process.env.MEDIA_SERVER_SHUTDOWN_GRACE_MS = "120000";
		expect(getShutdownGraceMs()).toBe(120_000);
	});

	test("bounds the idle timeout to Bun's maximum", () => {
		delete process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS;
		expect(getIdleTimeoutSeconds()).toBe(255);
		process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS = "90";
		expect(getIdleTimeoutSeconds()).toBe(90);
		process.env.MEDIA_SERVER_IDLE_TIMEOUT_SECONDS = "10000";
		expect(getIdleTimeoutSeconds()).toBe(255);
	});

	test("ignores servers without per-request timeouts", () => {
		const calls: Array<[Request, number]> = [];
		const request = new Request("http://localhost/video/convert");
		setRequestIdleTimeout(undefined, request, 0);
		setRequestIdleTimeout(
			{
				timeout: (req: Request, seconds: number) => calls.push([req, seconds]),
			},
			request,
			0,
		);
		expect(calls).toEqual([[request, 0]]);
	});
});

describe("drain", () => {
	test("waits for background work and in-flight requests", async () => {
		const work = deferred();
		const task = trackBackgroundTask(work.promise);
		const endRequest = beginRequest();
		expect(isIdle()).toBe(false);
		expect(getDrainBlockers().backgroundTasks).toBeGreaterThanOrEqual(1);

		const drained = waitForDrain(5_000);
		await Bun.sleep(50);
		work.resolve();
		await task;
		await Bun.sleep(50);
		endRequest();

		expect(await drained).toBe(true);
		expect(isIdle()).toBe(true);
	});

	test("gives up when the grace period elapses", async () => {
		const work = deferred();
		const task = trackBackgroundTask(work.promise);
		const startedAt = Date.now();

		expect(await waitForDrain(300)).toBe(false);
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250);

		work.resolve();
		await task;
	});

	test("stops tracking rejected background work", async () => {
		const failure = trackBackgroundTask(Promise.reject(new Error("failed")));
		await failure.catch(() => {});
		await Bun.sleep(0);
		expect(await waitForDrain(1_000)).toBe(true);
	});
});

describe("shutdown handler", () => {
	test("keeps today's immediate shutdown when no grace period is set", async () => {
		const work = deferred();
		const task = trackBackgroundTask(work.promise);
		let finalized = 0;
		const shutdown = createShutdownHandler(
			async () => {
				finalized++;
			},
			() => 0,
		);

		await shutdown("SIGTERM");
		await shutdown("SIGTERM");

		expect(finalized).toBe(1);
		expect(isDraining()).toBe(false);
		work.resolve();
		await task;
	});

	test("drains before finalizing when a grace period is set", async () => {
		const work = deferred();
		const task = trackBackgroundTask(work.promise);
		let finalizedWhileBusy: boolean | undefined;
		const shutdown = createShutdownHandler(
			async () => {
				finalizedWhileBusy = !isIdle();
			},
			() => 10_000,
		);

		const shuttingDown = shutdown("SIGTERM");
		await Bun.sleep(50);
		expect(isDraining()).toBe(true);
		expect(finalizedWhileBusy).toBeUndefined();

		work.resolve();
		await task;
		await shuttingDown;
		expect(finalizedWhileBusy).toBe(false);
	});

	test("forces the immediate path on a second signal", async () => {
		const work = deferred();
		const task = trackBackgroundTask(work.promise);
		let finalized = 0;
		const shutdown = createShutdownHandler(
			async () => {
				finalized++;
			},
			() => 60_000,
		);

		const shuttingDown = shutdown("SIGTERM");
		await Bun.sleep(50);
		expect(finalized).toBe(0);
		await shutdown("SIGINT");
		await shuttingDown;
		expect(finalized).toBe(1);

		work.resolve();
		await task;
	});
});

describe("streamed response idle timeout", () => {
	test("comes back once, on the first chunk, and cancel still reaches the source", async () => {
		let restores = 0;
		let cancelled = false;
		let push: ReadableStreamDefaultController<Uint8Array> | undefined;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				push = controller;
			},
			cancel() {
				cancelled = true;
			},
		});
		const reader = restoreIdleTimeoutOnFirstChunk(source, () => {
			restores++;
		}).getReader();

		const first = reader.read();
		await Bun.sleep(10);
		expect(restores).toBe(0);

		push?.enqueue(new Uint8Array([1]));
		expect((await first).value).toEqual(new Uint8Array([1]));
		push?.enqueue(new Uint8Array([2]));
		await reader.read();
		expect(restores).toBe(1);

		await reader.cancel();
		expect(cancelled).toBe(true);
	});
});
