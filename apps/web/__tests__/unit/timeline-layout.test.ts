import { describe, expect, it } from "vitest";
import {
	CLUSTER_MAX,
	MIN_NODE_GAP,
	RAIL_PAD_X,
} from "@/app/s/[videoId]/_components/timeline/timeline-constants";
import {
	type BranchNode,
	branchComments,
	type LayoutComment,
	layoutBranches,
} from "@/app/s/[videoId]/_components/timeline/timeline-layout";

/**
 * 1000px of usable rail over a 100s video: one second of video is ten pixels,
 * so the 26px minimum gap works out to a tidy 2.6s.
 */
const TRACK_WIDTH = 1000 + RAIL_PAD_X * 2;
const DURATION = 100;
const WINDOW = { start: 0, end: DURATION };
const GAP_SECONDS = (MIN_NODE_GAP / 1000) * DURATION;

let sequence = 0;
const comment = (
	timestamp: number | null,
	overrides: Partial<LayoutComment> = {},
): LayoutComment => {
	sequence += 1;
	return {
		id: `c${sequence}`,
		timestamp,
		createdAt: new Date(1_700_000_000_000 + sequence * 1000),
		...overrides,
	};
};

const at = (nodes: BranchNode[], index: number) => {
	const node = nodes[index];
	if (!node) throw new Error(`no node at ${index}`);
	return node;
};

describe("layoutBranches", () => {
	it("returns nothing for empty input, or when the window has no span", () => {
		expect(layoutBranches([], WINDOW, TRACK_WIDTH)).toEqual([]);
		expect(
			layoutBranches([comment(5)], { start: 0, end: 0 }, TRACK_WIDTH),
		).toEqual([]);
		expect(
			layoutBranches([comment(5)], { start: 0, end: Number.NaN }, TRACK_WIDTH),
		).toEqual([]);
	});

	it("drops comments that are not pinned to a moment", () => {
		const nodes = layoutBranches(
			[comment(null), comment(null)],
			WINDOW,
			TRACK_WIDTH,
		);
		expect(nodes).toEqual([]);
	});

	it("places a single comment on lane 0", () => {
		const only = comment(12.5);
		const nodes = layoutBranches([only], WINDOW, TRACK_WIDTH);

		expect(nodes).toHaveLength(1);
		const node = at(nodes, 0);
		expect(node.kind).toBe("single");
		expect(node.lane).toBe(0);
		expect(node.t).toBe(12.5);
		expect(node.id).toBe(only.id);
	});

	it("keeps well-spaced comments on lane 0 in time order", () => {
		const nodes = layoutBranches(
			[comment(60), comment(10), comment(35)],
			WINDOW,
			TRACK_WIDTH,
		);

		expect(nodes.map((node) => node.t)).toEqual([10, 35, 60]);
		expect(nodes.every((node) => node.lane === 0)).toBe(true);
		expect(nodes.every((node) => node.kind === "single")).toBe(true);
	});

	it("breaks timestamp ties by creation time", () => {
		const later = comment(20, {
			id: "later",
			createdAt: new Date("2026-01-02T00:00:00Z"),
		});
		const earlier = comment(20, {
			id: "earlier",
			createdAt: new Date("2026-01-01T00:00:00Z"),
		});

		// Same instant, so they land on separate lanes rather than one stack; the
		// older of the two is still laid out first.
		const nodes = layoutBranches([later, earlier], WINDOW, TRACK_WIDTH);
		expect(
			nodes.flatMap((node) => branchComments(node)).map((c) => c.id),
		).toEqual(["earlier", "later"]);
		expect(nodes.map((node) => node.lane)).toEqual([0, 1]);
	});

	it("pushes a colliding comment to lane 1", () => {
		const nodes = layoutBranches(
			[comment(10), comment(10 + GAP_SECONDS / 2)],
			WINDOW,
			TRACK_WIDTH,
		);

		expect(nodes).toHaveLength(2);
		expect(at(nodes, 0).lane).toBe(0);
		expect(at(nodes, 1).lane).toBe(1);
		expect(nodes.every((node) => node.kind === "single")).toBe(true);
	});

	it("folds a third collision into a cluster on the most recent node", () => {
		const first = comment(10);
		const second = comment(10.2);
		const third = comment(10.4);
		const nodes = layoutBranches([first, second, third], WINDOW, TRACK_WIDTH);

		expect(nodes).toHaveLength(2);
		const overflow = at(nodes, 1);
		expect(overflow.kind).toBe("cluster");
		expect(overflow.lane).toBe(1);
		// The cluster keeps its first member's position, not the newcomer's.
		expect(overflow.t).toBe(10.2);
		expect(branchComments(overflow).map((c) => c.id)).toEqual([
			second.id,
			third.id,
		]);
	});

	it("caps a cluster and starts a new one once it is full", () => {
		// Two singles (one per lane) plus enough collisions to fill a cluster and
		// spill into the next.
		const crowd = Array.from({ length: CLUSTER_MAX + 4 }, (_, index) =>
			comment(10 + index * 0.01),
		);
		const nodes = layoutBranches(crowd, WINDOW, TRACK_WIDTH);

		const clusters = nodes.filter((node) => node.kind === "cluster");
		expect(clusters.length).toBeGreaterThanOrEqual(2);
		for (const cluster of clusters) {
			expect(branchComments(cluster).length).toBeLessThanOrEqual(CLUSTER_MAX);
		}
		expect(branchComments(clusters[0] as BranchNode)).toHaveLength(CLUSTER_MAX);

		// Nothing is lost on the way through.
		const total = nodes.reduce(
			(sum, node) => sum + branchComments(node).length,
			0,
		);
		expect(total).toBe(crowd.length);
	});

	it("falls back to lane 0 for everything before the band is measured", () => {
		const nodes = layoutBranches(
			[comment(10), comment(10.1), comment(10.2)],
			WINDOW,
			0,
		);

		expect(nodes).toHaveLength(3);
		expect(nodes.every((node) => node.lane === 0)).toBe(true);
	});

	it("honours a wider minimum gap", () => {
		const spaced = [comment(10), comment(10 + GAP_SECONDS * 1.2)];

		expect(layoutBranches(spaced, WINDOW, TRACK_WIDTH)).toHaveLength(2);
		expect(
			layoutBranches(spaced, WINDOW, TRACK_WIDTH).every(
				(node) => node.lane === 0,
			),
		).toBe(true);

		// Same comments, a gap they no longer clear.
		const tighter = layoutBranches(
			spaced,
			WINDOW,
			TRACK_WIDTH,
			MIN_NODE_GAP * 2,
		);
		expect(at(tighter, 1).lane).toBe(1);
	});

	it("culls comments outside the window, keeping a small margin", () => {
		const window = { start: 40, end: 60 };
		const inside = comment(50);
		const nodes = layoutBranches(
			[comment(10), inside, comment(90)],
			window,
			TRACK_WIDTH,
		);

		expect(nodes.map((node) => node.id)).toEqual([inside.id]);

		// Just outside the edges, but within the 2% margin, so still drawn.
		const edge = layoutBranches(
			[comment(39.8), comment(60.2)],
			window,
			TRACK_WIDTH,
		);
		expect(edge).toHaveLength(2);
	});

	it("separates comments that collide zoomed out once the window narrows", () => {
		const pair = [comment(50), comment(51)];

		const wide = layoutBranches(pair, WINDOW, TRACK_WIDTH);
		expect(wide.map((node) => node.lane)).toEqual([0, 1]);

		// 10s of video across the same rail: a second is now 100px apart, well
		// clear of the minimum gap.
		const zoomed = layoutBranches(pair, { start: 45, end: 55 }, TRACK_WIDTH);
		expect(zoomed.map((node) => node.lane)).toEqual([0, 0]);
	});
});
