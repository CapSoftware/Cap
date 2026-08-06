"use client";

import { AnimatePresence, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CommentType } from "../../Share";
import { TimelineBranch } from "./TimelineBranch";
import { TimelineBranchCard } from "./TimelineBranchCard";
import {
	type ClusterFace,
	TimelineBranchCluster,
} from "./TimelineBranchCluster";
import {
	useTimelineActions,
	useTimelineEnv,
	useTimelineState,
} from "./TimelineProvider";
import {
	CARD_CLOSE_GRACE,
	CARD_OPEN_DELAY,
	clampedRailLeft,
	fractionInWindow,
	NODE_SIZE,
} from "./timeline-constants";
import { formatClock } from "./timeline-format";
import type { BranchNode } from "./timeline-layout";

const CLUSTER_FACES = 3;

interface TimelineBranchesProps {
	branches: readonly BranchNode<CommentType>[];
	windowStart: number;
	windowEnd: number;
	stems: readonly [number, number];
	trackWidth: number;
	/** Live height of the comments shelf; cards anchor their feet to it. */
	shelfHeight: number;
	replyCounts: ReadonlyMap<string, number>;
	onSeek: (time: number) => void;
}

/**
 * The branch layer. One click and one hover listener for the whole band,
 * dispatched by `data-comment-id`, so a video with two hundred comments still
 * only has two listeners attached.
 */
export function TimelineBranches({
	branches,
	windowStart,
	windowEnd,
	stems,
	trackWidth,
	shelfHeight,
	replyCounts,
	onSeek,
}: TimelineBranchesProps) {
	const reduceMotion = useReducedMotion() ?? false;
	const { compact, hasHover } = useTimelineEnv();
	const { hoveredId, expandedId } = useTimelineState();
	const { setHoveredId, setExpandedId, toggleExpandedId } =
		useTimelineActions();

	const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const clearTimers = useCallback(() => {
		if (openTimer.current) clearTimeout(openTimer.current);
		if (closeTimer.current) clearTimeout(closeTimer.current);
		openTimer.current = null;
		closeTimer.current = null;
	}, []);

	useEffect(() => clearTimers, [clearTimers]);

	// Everything a node needs is precomputed here, so the memoised nodes below
	// only ever see primitives and stable arrays.
	const items = useMemo(
		() =>
			branches.map((node, index) => {
				const percent = Math.min(
					100,
					Math.max(0, fractionInWindow(node.t, windowStart, windowEnd) * 100),
				);
				return {
					node,
					// Clamped: the rail runs edge to edge now, so a node at 0:00 would
					// otherwise hang half off the surface.
					left: clampedRailLeft(percent, NODE_SIZE + 4),
					percent,
					stem: stems[node.lane],
					delay: Math.min(index * 0.018, 0.26),
					timeLabel: formatClock(node.t),
				};
			}),
		[branches, windowStart, windowEnd, stems],
	);

	const handlePointerOver = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!hasHover || compact) return;
		const target = (event.target as HTMLElement).closest("[data-comment-id]");
		const id = target?.getAttribute("data-comment-id") ?? null;
		if (!id || id === hoveredId) return;
		clearTimers();
		openTimer.current = setTimeout(() => setHoveredId(id), CARD_OPEN_DELAY);
	};

	const handlePointerOut = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!hasHover || compact) return;
		const next = event.relatedTarget;
		if (next instanceof Node && event.currentTarget.contains(next)) return;
		clearTimers();
		closeTimer.current = setTimeout(() => setHoveredId(null), CARD_CLOSE_GRACE);
	};

	const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
		const target = (event.target as HTMLElement).closest("[data-comment-id]");
		const id = target?.getAttribute("data-comment-id");
		if (!id) return;
		clearTimers();
		setHoveredId(null);
		toggleExpandedId(id);
	};

	const activeId = expandedId ?? (compact ? null : hoveredId);
	const active = activeId
		? items.find((item) => item.node.id === activeId)
		: undefined;

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: delegation layer only; every target inside is a real button.
		// biome-ignore lint/a11y/useKeyWithClickEvents: Enter and Space already fire click on those buttons.
		<div
			data-timeline-branches=""
			className="pointer-events-none absolute inset-0"
			onPointerOver={handlePointerOver}
			onPointerOut={handlePointerOut}
			onClick={handleClick}
		>
			{items.map((item) =>
				item.node.kind === "single" ? (
					<TimelineBranch
						key={item.node.id}
						id={item.node.id}
						left={item.left}
						stem={item.stem}
						glyph={item.node.comment.type}
						content={item.node.comment.content}
						avatarUrl={item.node.comment.authorImage ?? null}
						authorName={item.node.comment.authorName || "Someone"}
						timeLabel={item.timeLabel}
						sending={item.node.comment.sending === true}
						delay={item.delay}
						reduceMotion={reduceMotion}
						morphId={`branch-${item.node.id}`}
					/>
				) : (
					<TimelineBranchCluster
						key={item.node.id}
						id={item.node.id}
						left={item.left}
						stem={item.stem}
						faces={facesOf(item.node)}
						total={item.node.comments.length}
						timeLabel={item.timeLabel}
						delay={item.delay}
						reduceMotion={reduceMotion}
					/>
				),
			)}

			<AnimatePresence initial={false}>
				{active && !compact && (
					<TimelineBranchCard
						key={active.node.id}
						node={active.node}
						percent={active.percent}
						stem={active.stem}
						shelfHeight={shelfHeight}
						trackWidth={trackWidth}
						replyCounts={replyCounts}
						reduceMotion={reduceMotion}
						pinned={expandedId === active.node.id}
						onSeek={onSeek}
						onPin={setExpandedId}
						onKeepOpen={clearTimers}
						onClose={() => {
							clearTimers();
							setHoveredId(null);
							setExpandedId(null);
						}}
					/>
				)}
			</AnimatePresence>
		</div>
	);
}

const facesCache = new WeakMap<object, ClusterFace[]>();

/** Stable per-node face list so the cluster memo actually holds. */
function facesOf(node: Extract<BranchNode<CommentType>, { kind: "cluster" }>) {
	const cached = facesCache.get(node);
	if (cached) return cached;
	const faces = node.comments.slice(0, CLUSTER_FACES).map((comment) => ({
		id: comment.id,
		name: comment.authorName || "Someone",
		image: comment.authorImage ?? null,
	}));
	facesCache.set(node, faces);
	return faces;
}
