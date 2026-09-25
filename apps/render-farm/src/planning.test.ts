import { describe, expect, test } from "bun:test";
import { type ChunkPlanInput, planChunkBoundaries } from "./planning";

const base: ChunkPlanInput = {
	totalFrames: 1800,
	fps: 30,
	slots: 15,
	targetFrames: 1300,
	minChunkFrames: 30,
	leadInFrames: 0,
};

function expectValid(boundaries: number[], totalFrames: number) {
	expect(boundaries[0]).toBe(0);
	expect(boundaries.at(-1)).toBe(totalFrames);
	for (let index = 1; index < boundaries.length; index++) {
		expect(boundaries[index] ?? 0).toBeGreaterThan(boundaries[index - 1] ?? 0);
	}
}

describe("planChunkBoundaries", () => {
	test("a short export is one wave across every slot, on whole seconds", () => {
		const boundaries = planChunkBoundaries(base);
		expectValid(boundaries, 1800);
		expect(boundaries.length - 1).toBe(15);
		for (const boundary of boundaries.slice(0, -1))
			expect(boundary % 30).toBe(0);
	});

	test("a long export is whole waves of GOP-aligned chunks", () => {
		const input = { ...base, totalFrames: 216_000 };
		const boundaries = planChunkBoundaries(input);
		expectValid(boundaries, 216_000);
		expect((boundaries.length - 1) % 15).toBe(0);
		for (const boundary of boundaries.slice(0, -1))
			expect(boundary % 60).toBe(0);
	});

	test("the lead-in splits a short first chunk off long exports", () => {
		const input = { ...base, totalFrames: 216_000, leadInFrames: 120 };
		const without = planChunkBoundaries({ ...input, leadInFrames: 0 });
		const boundaries = planChunkBoundaries(input);
		expectValid(boundaries, 216_000);
		expect(boundaries[1]).toBe(120);
		expect(boundaries.length).toBe(without.length + 1);
	});

	test("no lead-in when the first chunk is already short", () => {
		const boundaries = planChunkBoundaries({ ...base, leadInFrames: 120 });
		expect(boundaries).toEqual(planChunkBoundaries(base));
	});

	test("maxChunks and pinned chunk counts are honoured", () => {
		expect(planChunkBoundaries({ ...base, maxChunks: 4 }).length - 1).toBe(4);
		expect(planChunkBoundaries({ ...base, chunks: 6 }).length - 1).toBe(6);
	});

	test("never plans more chunks than frames", () => {
		const boundaries = planChunkBoundaries({
			...base,
			totalFrames: 7,
			minChunkFrames: 1,
		});
		expectValid(boundaries, 7);
	});
});

test("all planner inputs leave six disjoint ranges even with a lead-in", () => {
	for (const options of [
		{ slots: 1000 },
		{ chunks: 1000 },
		{ chunks: 1000, maxChunks: 1000 },
	]) {
		const boundaries = planChunkBoundaries({
			...base,
			totalFrames: 2_160_000,
			leadInFrames: 120,
			...options,
		});
		const count = boundaries.length - 1;
		expect(Math.floor(Math.floor(9998 / count) / 6)).toBeGreaterThanOrEqual(3);
		expectValid(boundaries, 2_160_000);
	}
});
