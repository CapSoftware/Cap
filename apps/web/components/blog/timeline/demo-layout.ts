import type { DemoWindow } from "./DemoStrip";
import { fractionInWindow } from "./DemoStrip";
import type { DemoComment } from "./scene";

/**
 * A cut-down version of the timeline's branch layout: nodes hang off the moment
 * they belong to, drop to a second lane when they would touch, and fold into a
 * cluster once even that is full. The real one lives in
 * `_components/timeline/timeline-layout.ts` and handles a good deal more; this
 * exists so the demos can lay out six comments without dragging the share
 * page's domain types into a blog post.
 */

export interface DemoNode {
	comment: DemoComment;
	lane: 0 | 1;
	/** Position across the strip, 0-100. */
	percent: number;
	/** Comments folded into this node, including itself. */
	count: number;
	/** The folded comments, for the cluster card. */
	members: DemoComment[];
}

export function layoutDemoNodes(
	comments: readonly DemoComment[],
	window: DemoWindow,
	trackWidth: number,
	minGap: number,
): DemoNode[] {
	const visible = comments
		.filter((comment) => comment.t >= window.start && comment.t <= window.end)
		.sort((a, b) => a.t - b.t);

	const nodes: DemoNode[] = [];
	const lastX: [number, number] = [
		Number.NEGATIVE_INFINITY,
		Number.NEGATIVE_INFINITY,
	];

	for (const comment of visible) {
		const fraction = fractionInWindow(comment.t, window);
		const x = fraction * trackWidth;

		const lane: 0 | 1 | null =
			x - lastX[0] >= minGap ? 0 : x - lastX[1] >= minGap ? 1 : null;

		if (lane === null) {
			// Nowhere left to put it: it joins the node it collided with.
			const host = nodes[nodes.length - 1];
			if (host) {
				host.count += 1;
				host.members.push(comment);
				continue;
			}
		}

		const resolved: 0 | 1 = lane ?? 0;
		lastX[resolved] = x;
		nodes.push({
			comment,
			lane: resolved,
			percent: fraction * 100,
			count: 1,
			members: [comment],
		});
	}

	return nodes;
}
