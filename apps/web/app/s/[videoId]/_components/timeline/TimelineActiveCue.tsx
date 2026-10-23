"use client";

import { type RefObject, useEffect, useMemo, useRef } from "react";
import type { CommentType } from "../../Share";
import { useCoarseTime } from "../playback/PlaybackContext";
import { ACTIVE_CUE_WINDOW } from "./timeline-constants";
import type { BranchNode } from "./timeline-layout";

interface TimelineActiveCueProps {
	branches: readonly BranchNode<CommentType>[];
	containerRef: RefObject<HTMLDivElement | null>;
}

const escapeId = (id: string) =>
	typeof CSS !== "undefined" && typeof CSS.escape === "function"
		? CSS.escape(id)
		: id.replace(/["\\]/g, "\\$&");

/**
 * Rings whichever branch the playhead is currently sitting on.
 *
 * This is the only component in the band that re-renders while the video plays,
 * and it renders nothing: the highlight is a `data-active` attribute written
 * straight onto the node, so the memoised branches are never disturbed.
 */
export function TimelineActiveCue({
	branches,
	containerRef,
}: TimelineActiveCueProps) {
	const time = useCoarseTime(250);
	const previousRef = useRef<string | null>(null);

	const marks = useMemo(
		() => branches.map((node) => ({ id: node.id, t: node.t })),
		[branches],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		// Latest mark the playhead has reached, as long as it is still fresh.
		let next: string | null = null;
		for (const mark of marks) {
			if (mark.t > time + ACTIVE_CUE_WINDOW) break;
			if (Math.abs(mark.t - time) <= ACTIVE_CUE_WINDOW) next = mark.id;
		}

		if (next === previousRef.current) return;

		const find = (id: string) =>
			container.querySelector<HTMLElement>(
				`[data-comment-id="${escapeId(id)}"]`,
			);

		if (previousRef.current)
			find(previousRef.current)?.removeAttribute("data-active");
		if (next) find(next)?.setAttribute("data-active", "");
		previousRef.current = next;
	}, [marks, time, containerRef]);

	useEffect(
		() => () => {
			previousRef.current = null;
		},
		[],
	);

	return null;
}
