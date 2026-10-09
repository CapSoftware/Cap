import { describe, expect, test } from "bun:test";
import { MIN_PART } from "./protocol";
import {
	HEADER_PART,
	planStitch,
	type StashedChunk,
	StitchLimiter,
	stashBytes,
	uploadProblem,
} from "./stitch";

const MB = 1024 * 1024;

function chunk(index: number, bytes: number): StashedChunk {
	const slot = 2 + index * 100;
	const stash = stashBytes(bytes);
	const parts: StashedChunk["parts"] = [];
	let rest = bytes - stash;
	let partNumber = slot + 1;
	while (rest > 0) {
		const size = rest >= 16 * MB + MIN_PART ? 16 * MB : rest;
		parts.push({ partNumber: partNumber++, etag: `e${partNumber}`, size });
		rest -= size;
	}
	return { slot, stash: { key: `s/${index}`, bytes: stash }, parts };
}

function layout(header: number, chunks: StashedChunk[]) {
	const plan = planStitch(header, chunks);
	const all = [
		...plan.map((part) => ({ partNumber: part.partNumber, size: part.bytes })),
		...chunks.flatMap((c) =>
			c.parts.map((part) => ({ partNumber: part.partNumber, size: part.size })),
		),
	].sort((a, b) => a.partNumber - b.partNumber);
	return { plan, all };
}

function expectValid(header: number, bytes: number[]) {
	const chunks = bytes.map((b, i) => chunk(i, b));
	const { plan, all } = layout(header, chunks);
	for (const part of all.slice(0, -1)) {
		expect(part.size).toBeGreaterThanOrEqual(MIN_PART);
	}
	const numbers = all.map((part) => part.partNumber);
	expect(new Set(numbers).size).toBe(numbers.length);
	expect(all.reduce((sum, part) => sum + part.size, 0)).toBe(
		header + bytes.reduce((sum, b) => sum + b, 0),
	);
	// Sources appear in file order: header first, then each chunk's stash.
	const order = plan
		.flatMap((part) => part.sources)
		.map((s) => (s.kind === "header" ? -1 : Number(s.key.slice(2))));
	expect(order).toEqual([-1, ...bytes.map((_, i) => i)]);
	return plan;
}

describe("planStitch", () => {
	test("a short export becomes one part with no padding", () => {
		const plan = expectValid(40_000, Array(9).fill(220_000));
		expect(plan).toHaveLength(1);
		expect(plan[0]?.partNumber).toBe(HEADER_PART);
		expect(plan[0]?.bytes).toBe(40_000 + 9 * 220_000);
	});

	test("large chunks copy their stashes and only the header is joined", () => {
		const plan = expectValid(300_000, Array(6).fill(40 * MB));
		expect(plan[0]?.sources.map((s) => s.kind)).toEqual(["header", "stash"]);
		for (const part of plan.slice(1)) expect(part.sources).toHaveLength(1);
	});

	test("mixed and awkward sizes always form valid parts", () => {
		const sizes = [
			[3 * MB, 0.1 * MB, 12 * MB, 0.2 * MB, 0.2 * MB, 7 * MB, 30 * MB, 1 * MB],
			[6 * MB, 6 * MB, 6 * MB],
			[0.5 * MB, 50 * MB, 0.5 * MB],
			[MIN_PART - 1, MIN_PART, MIN_PART + 1, 2 * MIN_PART - 1, 2 * MIN_PART],
			[1],
		];
		for (const bytes of sizes) expectValid(1000, bytes.map(Math.round));
	});
});

describe("uploadProblem", () => {
	const upload = { stashKey: "s/0", firstPart: 3, partLimit: 10 };
	test("accepts a chunk split as the worker splits it", () => {
		const c = chunk(0, 40 * MB);
		expect(
			uploadProblem(
				{ ...upload, firstPart: c.slot + 1 },
				{ bytes: 40 * MB, stash: c.stash, parts: c.parts },
			),
		).toBeNull();
	});
	test("rejects padding, missing bytes and foreign stashes", () => {
		expect(
			uploadProblem(upload, {
				bytes: MB,
				stash: { key: "s/0", bytes: MB },
				parts: [],
			}),
		).toBeNull();
		expect(
			uploadProblem(upload, {
				bytes: MB,
				stash: { key: "s/1", bytes: MB },
				parts: [],
			}),
		).toContain("dispatch");
		expect(
			uploadProblem(upload, {
				bytes: 12 * MB,
				stash: { key: "s/0", bytes: MIN_PART },
				parts: [{ partNumber: 3, size: 6 * MB }],
			}),
		).toContain("add up");
		expect(
			uploadProblem(upload, {
				bytes: 14 * MB,
				stash: { key: "s/0", bytes: MIN_PART },
				parts: [
					{ partNumber: 3, size: 6 * MB },
					{ partNumber: 4, size: 14 * MB - MIN_PART - 6 * MB },
				],
			}),
		).toContain("minimum");
		expect(
			uploadProblem(upload, {
				bytes: 20 * MB,
				stash: { key: "s/0", bytes: MIN_PART },
				parts: [{ partNumber: 13, size: 20 * MB - MIN_PART }],
			}),
		).toContain("range");
	});
});

describe("planStitch ahead of assembly", () => {
	test("parts planned for an accepted run are the parts of the final plan", () => {
		const sizes = [0.3, 12, 0.2, 0.2, 7, 30, 1, 0.4, 6, 0.1].map((mb) =>
			Math.round(mb * MB),
		);
		const chunks = sizes.map((bytes, index) => chunk(index, bytes));
		const final = planStitch(0, chunks);
		const key = (part: {
			partNumber: number;
			sources: { kind: string; key?: string }[];
		}) =>
			`${part.partNumber}:${part.sources.map((s) => s.key ?? s.kind).join(",")}`;
		const finalKeys = new Set(final.map(key));
		for (let run = 1; run < chunks.length; run++) {
			for (const part of planStitch(0, chunks.slice(0, run), {
				partial: true,
			})) {
				expect(finalKeys.has(key(part))).toBe(true);
			}
		}
	});
});

describe("stitch limiter", () => {
	function held() {
		let release = () => {};
		const done = new Promise<void>((resolve) => {
			release = resolve;
		});
		return { done, release };
	}
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	test("never runs more than its limits, in total, ahead and per job", async () => {
		const limiter = new StitchLimiter({ total: 6, ahead: 4, aheadPerJob: 2 });
		let running = 0;
		let ahead = 0;
		const perJob = new Map<string, number>();
		const peaks = { running: 0, ahead: 0, perJob: 0 };
		const work = (job: string, isAhead: boolean) =>
			limiter.run(job, isAhead, async () => {
				running++;
				if (isAhead) {
					ahead++;
					perJob.set(job, (perJob.get(job) ?? 0) + 1);
				}
				peaks.running = Math.max(peaks.running, running);
				peaks.ahead = Math.max(peaks.ahead, ahead);
				peaks.perJob = Math.max(peaks.perJob, perJob.get(job) ?? 0);
				await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
				running--;
				if (isAhead) {
					ahead--;
					perJob.set(job, (perJob.get(job) ?? 1) - 1);
				}
			});
		await Promise.all(
			Array.from({ length: 200 }, (_, index) =>
				work(`j${index % 5}`, index % 3 !== 0),
			),
		);
		expect(peaks).toEqual({ running: 6, ahead: 4, perJob: 2 });
	});

	test("assembly is admitted before queued ahead work", async () => {
		const limiter = new StitchLimiter({ total: 2, ahead: 2, aheadPerJob: 2 });
		const order: string[] = [];
		const first = held();
		const second = held();
		const running = [
			limiter.run("a", true, () => first.done),
			limiter.run("a", true, () => second.done),
		];
		const queued = [
			limiter.run("b", true, async () => {
				order.push("b ahead");
			}),
			limiter.run("c", false, async () => {
				order.push("c assembly");
			}),
		];
		await tick();
		expect(order).toEqual([]);
		first.release();
		await Promise.all(queued);
		expect(order).toEqual(["c assembly", "b ahead"]);
		second.release();
		await Promise.all(running);
	});

	test("promoting a job lifts its queued work past the ahead limits", async () => {
		const limiter = new StitchLimiter({ total: 3, ahead: 1, aheadPerJob: 1 });
		const busy = held();
		const blocking = limiter.run("a", true, () => busy.done);
		let started = 0;
		const queued = [1, 2].map(() =>
			limiter.run("a", true, async () => {
				started++;
			}),
		);
		await tick();
		expect(started).toBe(0);
		limiter.promote("a");
		await Promise.all(queued);
		expect(started).toBe(2);
		busy.release();
		await blocking;
	});

	test("cancelling an ended job drops all its queued work, promoted too", async () => {
		const limiter = new StitchLimiter({ total: 1, ahead: 1, aheadPerJob: 1 });
		const busy = held();
		const blocking = limiter.run("b", false, () => busy.done);
		const aheadWork = limiter.run("a", true, async () => "ran");
		const promoted = limiter.run("a", true, async () => "ran");
		limiter.promote("a");
		const assembly = limiter.run("a", false, async () => "assembled");
		const other = limiter.run("b", false, async () => "other");
		limiter.cancel("a");
		const settled = await Promise.allSettled([aheadWork, promoted, assembly]);
		for (const outcome of settled) {
			expect(outcome.status).toBe("rejected");
			expect(String((outcome as PromiseRejectedResult).reason)).toContain(
				"ended before its stitch ran",
			);
		}
		busy.release();
		await blocking;
		expect(await other).toBe("other");
	});
});
