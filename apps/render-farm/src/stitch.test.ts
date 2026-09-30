import { describe, expect, test } from "bun:test";
import { MIN_PART } from "./protocol";
import {
	HEADER_PART,
	planStitch,
	type StashedChunk,
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

/** The whole file as S3 will join it: header, then every chunk in order. */
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
