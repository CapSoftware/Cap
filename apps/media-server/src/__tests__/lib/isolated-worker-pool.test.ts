import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
	createWorkerPool,
	WorkerLostError,
	type WorkerPool,
} from "../../lib/isolated-worker-pool";

type Request = { op: string; ms?: number };

const pools: WorkerPool<Request>[] = [];

class Refused extends Error {
	constructor(readonly pid: number) {
		super("refused");
	}
}
class Fault extends Error {}

function pool(maxWorkers = 2) {
	const created = createWorkerPool<Request, { message: string; pid: number }>({
		entry: join(import.meta.dir, "..", "fixtures", "pool-test-worker.ts"),
		env: () => ({ PATH: process.env.PATH ?? "" }),
		memoryLimitMB: () => 4096,
		toError: (failure) => new Refused(failure.pid),
		memoryError: () => new Error("memory"),
		faultError: () => new Fault("the worker stopped on this request"),
		faultExitCode: 70,
		maxWorkers: () => maxWorkers,
		label: "test worker",
	});
	pools.push(created);
	return created;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

afterEach(() => {
	for (const created of pools.splice(0)) created.stop();
});

describe("isolated worker pool", () => {
	test("reuses a worker across requests, including one it answered with a failure", async () => {
		const workers = pool();
		const first = (await workers.run({ op: "pid" }, 10_000)) as number;
		const refused = await workers
			.run({ op: "fail" }, 10_000)
			.catch((error: unknown) => error);
		expect(refused).toBeInstanceOf(Refused);
		expect((refused as Refused).pid).toBe(first);
		expect(await workers.run({ op: "pid" }, 10_000)).toBe(first);
		expect(workers.stats().recycled).toBe(0);
	}, 30_000);

	test("stops a worker that overruns its time and serves the next request on a new one", async () => {
		const workers = pool();
		const first = (await workers.run({ op: "pid" }, 10_000)) as number;
		const started = performance.now();
		const error = await workers
			.run({ op: "spin" }, 300)
			.catch((caught: unknown) => caught);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect((error as Error).message).toContain("timed out");
		await Bun.sleep(100);
		expect(isAlive(first)).toBe(false);
		const next = (await workers.run({ op: "pid" }, 10_000)) as number;
		expect(next).not.toBe(first);
		expect(workers.stats().timeoutKills).toBe(1);
	}, 30_000);

	test("a worker that crashes fails only its own request and is replaced", async () => {
		const workers = pool();
		const first = (await workers.run({ op: "pid" }, 10_000)) as number;
		expect(
			await workers.run({ op: "crash" }, 10_000).catch((error) => error),
		).toBeInstanceOf(Fault);
		expect(
			await workers.run({ op: "die" }, 10_000).catch((error) => error),
		).toBeInstanceOf(WorkerLostError);
		const next = (await workers.run({ op: "pid" }, 10_000)) as number;
		expect(next).not.toBe(first);
		expect(isAlive(first)).toBe(false);
	}, 30_000);

	test("never runs more workers than its limit, and queued requests wait", async () => {
		const workers = pool(2);
		const pids = (await Promise.all(
			Array.from({ length: 6 }, () =>
				workers.run({ op: "slow", ms: 300 }, 20_000),
			),
		)) as number[];
		expect(new Set(pids).size).toBeLessThanOrEqual(2);
		expect(workers.stats().started).toBeLessThanOrEqual(2);
		expect(workers.stats().waiting).toBe(0);
	}, 30_000);

	test("a queued request that waits past its deadline times out without a worker", async () => {
		const workers = pool(1);
		const busy = workers.run({ op: "slow", ms: 1_500 }, 20_000);
		const queued = await workers
			.run({ op: "pid" }, 200)
			.catch((error: unknown) => error);
		expect((queued as Error).message).toContain("timed out");
		await busy;
		expect(workers.stats().waiting).toBe(0);
	}, 30_000);

	test("a request cancelled while it waits for a worker is never sent", async () => {
		const workers = pool(1);
		const first = (await workers.run({ op: "pid" }, 10_000)) as number;
		const busy = workers.run({ op: "slow", ms: 500 }, 20_000);
		const controller = new AbortController();
		const queued = workers
			.run({ op: "crash" }, 20_000, controller.signal)
			.catch((error: unknown) => error);
		controller.abort(new Error("cancelled"));
		expect(((await queued) as Error).message).toBe("cancelled");
		expect(await busy).toBe(first);
		// Had the crash been sent, this worker would be gone.
		expect(await workers.run({ op: "pid" }, 10_000)).toBe(first);
		expect(workers.stats().started).toBe(1);
	}, 30_000);
});
