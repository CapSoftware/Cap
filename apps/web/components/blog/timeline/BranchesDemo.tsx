"use client";

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";
import {
	AnchorLine,
	BranchNode,
	Clock,
	CommentCard,
	CommentRow,
	LANE_STEM,
	MIN_NODE_GAP,
	NODE_SIZE,
	TransportButton,
} from "./DemoBits";
import { DemoButton, DemoPanel } from "./DemoPanel";
import {
	DemoPlayhead,
	DemoStrip,
	FULL_WINDOW,
	useMeasuredWidth,
} from "./DemoStrip";
import { layoutDemoNodes } from "./demo-layout";
import { MockFrame } from "./MockFrame";
import { DEMO_COMMENTS } from "./scene";
import { useDemoClock } from "./useDemoClock";

/** How close the playhead has to be for a node to read as "now", in seconds. */
const ACTIVE_WINDOW = 2;

/**
 * The whole idea in one control: take the six comments out of the list and hang
 * them off the moments they are about. Two of them collide, which is what the
 * second lane and the cluster node are for.
 */
export function BranchesDemo() {
	const reduceMotion = useReducedMotion() ?? false;
	const clock = useDemoClock({ initial: 0 });
	const [onTimeline, setOnTimeline] = useState(false);
	const [openId, setOpenId] = useState<string | null>(null);
	const [ref, width] = useMeasuredWidth<HTMLDivElement>();

	const nodes = useMemo(
		() =>
			onTimeline
				? layoutDemoNodes(DEMO_COMMENTS, FULL_WINDOW, width, MIN_NODE_GAP)
				: [],
		[onTimeline, width],
	);

	const shelfHeight =
		nodes.length > 0
			? Math.max(...nodes.map((node) => LANE_STEM[node.lane])) +
				NODE_SIZE / 2 +
				12
			: 0;

	const open = nodes.find((node) => node.comment.id === openId) ?? null;

	return (
		<DemoPanel
			title="Comments, hung off the moment"
			hint={
				onTimeline
					? "Press play and watch them come up. Click a node to open it and jump there."
					: "Move the six comments out of the list and onto the recording."
			}
			action={
				<DemoButton
					variant={onTimeline ? "ghost" : "solid"}
					onClick={() => {
						setOnTimeline((value) => !value);
						setOpenId(null);
					}}
				>
					{onTimeline ? "Back to the list" : "Move onto the timeline"}
				</DemoButton>
			}
			caption="Nothing was summarised, sorted or thrown away. The same six comments are simply drawn where they happened. Two of them land three seconds apart, so the later one drops to a second lane, and the third folds into it as a count."
		>
			<div className="overflow-hidden rounded-xl border border-gray-4 bg-white">
				<div className="relative aspect-video bg-[hsl(224,71.4%,4.1%)]">
					<MockFrame time={clock.time} className="absolute inset-0 size-full" />
				</div>

				<div ref={ref}>
					<DemoStrip
						time={clock.time}
						onSeek={(t) => {
							clock.pause();
							clock.seek(t);
						}}
					>
						<DemoPlayhead time={clock.time} />
					</DemoStrip>
				</div>

				{/* The shelf: collapses to nothing when there is nothing on it, which
				    is exactly what the real one does. */}
				<div
					className="relative transition-[height] duration-300"
					style={{ height: shelfHeight }}
				>
					{nodes.length > 0 && <AnchorLine />}

					{nodes.map((node, index) => (
						<BranchNode
							key={node.comment.id}
							node={node}
							delay={index * 0.045}
							active={
								openId === node.comment.id ||
								Math.abs(clock.time - node.comment.t) < ACTIVE_WINDOW
							}
							onSelect={() => {
								clock.pause();
								clock.seek(node.comment.t);
								setOpenId((current) =>
									current === node.comment.id ? null : node.comment.id,
								);
							}}
						/>
					))}

					{/* Positioning stays on a plain wrapper: motion writes its own
					    inline `transform` for the entry animation, which would drop the
					    class-based -translate-x-1/2 and push the card off the panel. */}
					{open && (
						<div
							className="absolute bottom-full z-40 mb-2 -translate-x-1/2"
							style={{
								left: `clamp(8.5rem, ${open.percent}%, 100% - 8.5rem)`,
							}}
						>
							<AnimatePresence>
								<motion.div
									key={open.comment.id}
									initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
									animate={{ opacity: 1, y: 0 }}
									exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
									transition={{ duration: 0.16 }}
								>
									<CommentCard comments={open.members} />
								</motion.div>
							</AnimatePresence>
						</div>
					)}
				</div>

				<div className="flex items-center gap-2 border-t border-gray-4 bg-white px-2 py-2 sm:px-3">
					<TransportButton playing={clock.playing} onClick={clock.toggle} />
					<span className="flex-1" />
					<Clock time={clock.time} />
				</div>
			</div>

			<div className="mt-4 rounded-xl border border-gray-4 bg-gray-1 p-1.5">
				<div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-10">
					{onTimeline
						? "The sidebar, now"
						: `Comments · ${DEMO_COMMENTS.length}`}
				</div>
				{onTimeline ? (
					<div className="px-2 pb-2 text-[13px] leading-relaxed text-gray-10">
						Empty. Every one of them is up there, on the second it belongs to.
					</div>
				) : (
					<div className="flex flex-col">
						{DEMO_COMMENTS.map((comment) => (
							<CommentRow
								key={comment.id}
								comment={comment}
								onClick={() => {
									clock.pause();
									clock.seek(comment.t);
								}}
							/>
						))}
					</div>
				)}
			</div>
		</DemoPanel>
	);
}
