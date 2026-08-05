/**
 * Branch layout for the timeline band. Pure on purpose: no React, no DOM, no
 * imports beyond the geometry constants, so the collision rules can be unit
 * tested without a renderer.
 */

import { CLUSTER_MAX, MIN_NODE_GAP, usableWidth } from "./timeline-constants";
import type { TimelineWindow } from "./timeline-window";

/** Slack outside the window, as a share of its span, before a branch is culled. */
const CULL_MARGIN = 0.02;

/** The only fields the layout cares about. */
export interface LayoutComment {
	id: string;
	timestamp: number | null;
	createdAt: Date | string | number;
}

export type BranchLane = 0 | 1;

export type BranchNode<C extends LayoutComment = LayoutComment> =
	| { kind: "single"; id: string; t: number; lane: BranchLane; comment: C }
	| { kind: "cluster"; id: string; t: number; lane: BranchLane; comments: C[] };

const toMillis = (value: Date | string | number): number => {
	if (value instanceof Date) return value.getTime();
	const parsed = new Date(value).getTime();
	return Number.isFinite(parsed) ? parsed : 0;
};

const hasTime = <C extends LayoutComment>(
	comment: C,
): comment is C & { timestamp: number } =>
	typeof comment.timestamp === "number" && Number.isFinite(comment.timestamp);

/**
 * Place every timestamped comment visible in `window` on one of two lanes,
 * folding anything that still collides into the node before it.
 *
 * Greedy and single-pass: lane 0 if it clears the last lane-0 node, else lane 1
 * if it clears the last lane-1 node, else it joins the most recent node (which
 * becomes a cluster). Clusters stop growing at `CLUSTER_MAX` and a fresh one
 * takes over, so a hundred comments on the same second render as a handful of
 * stacks rather than one unbounded pile.
 *
 * Collision distances are measured against the window, not the video, so
 * zooming in genuinely separates comments that were stacked when zoomed out.
 */
export function layoutBranches<C extends LayoutComment>(
	comments: readonly C[],
	window: TimelineWindow,
	trackWidth: number,
	minNodeGap: number = MIN_NODE_GAP,
): BranchNode<C>[] {
	if (!comments.length) return [];
	const span = window.end - window.start;
	if (!Number.isFinite(span) || span <= 0) return [];

	const margin = span * CULL_MARGIN;
	const from = window.start - margin;
	const to = window.end + margin;

	const placed = comments
		.filter(hasTime)
		.filter((comment) => comment.timestamp >= from && comment.timestamp <= to)
		.sort((a, b) => {
			if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
			return toMillis(a.createdAt) - toMillis(b.createdAt);
		});
	if (!placed.length) return [];

	const usable = usableWidth(trackWidth);
	// Before the band has been measured there is no collision to resolve, so
	// everything lands on lane 0 and re-lays out once the observer fires.
	const minGapT = usable > 0 ? (minNodeGap / usable) * span : 0;

	const nodes: BranchNode<C>[] = [];
	const lastInLane: [number, number] = [
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];

	const push = (comment: C & { timestamp: number }, lane: BranchLane) => {
		nodes.push({
			kind: "single",
			id: comment.id,
			t: comment.timestamp,
			lane,
			comment,
		});
		lastInLane[lane] = comment.timestamp;
	};

	for (const comment of placed) {
		const t = comment.timestamp;

		if (t - lastInLane[0] >= minGapT) {
			push(comment, 0);
			continue;
		}
		if (t - lastInLane[1] >= minGapT) {
			push(comment, 1);
			continue;
		}

		// Comments are sorted ascending and every node keeps its first comment's
		// time, so the last node pushed is always the nearest one to fold into.
		const last = nodes[nodes.length - 1];
		if (!last) {
			push(comment, 0);
			continue;
		}

		if (last.kind === "single") {
			nodes[nodes.length - 1] = {
				kind: "cluster",
				id: last.id,
				t: last.t,
				lane: last.lane,
				comments: [last.comment, comment],
			};
			continue;
		}

		if (last.comments.length < CLUSTER_MAX) {
			last.comments.push(comment);
			continue;
		}

		// Full: start a new stack in the same lane and measure future gaps from it.
		nodes.push({
			kind: "cluster",
			id: comment.id,
			t,
			lane: last.lane,
			comments: [comment],
		});
		lastInLane[last.lane] = t;
	}

	return nodes;
}

/** Every comment a node stands for, single or cluster. */
export const branchComments = <C extends LayoutComment>(
	node: BranchNode<C>,
): C[] => (node.kind === "single" ? [node.comment] : node.comments);
