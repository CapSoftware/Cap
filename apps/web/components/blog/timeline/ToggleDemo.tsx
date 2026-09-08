"use client";

import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
	type ShareView,
	ShareViewToggle,
} from "@/app/s/[videoId]/_components/ShareViewToggle";
import {
	AnchorLine,
	BranchNode,
	Clock,
	LANE_STEM,
	MIN_NODE_GAP,
	NODE_SIZE,
	PlainSeekBar,
	TransportButton,
} from "./DemoBits";
import { DemoPanel } from "./DemoPanel";
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

/**
 * The two views, side by side in time. Same recording, same position, same
 * controls — the seek bar is simply replaced by the strip, and the transport
 * moves out from over the video into the row that closes the card.
 *
 * The `T` shortcut is bound only while the pointer is over this demo, so the
 * rest of the page keeps its keyboard.
 */
export function ToggleDemo() {
	const reduceMotion = useReducedMotion() ?? false;
	const clock = useDemoClock({ initial: 44 });
	const [view, setView] = useState<ShareView>("classic");
	const [hovering, setHovering] = useState(false);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const [stripRef, width] = useMeasuredWidth<HTMLDivElement>();

	useEffect(() => {
		if (!hovering) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "t" && event.key !== "T") return;
			if (event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target as HTMLElement | null;
			if (
				target instanceof HTMLInputElement ||
				target instanceof HTMLTextAreaElement ||
				target?.isContentEditable
			) {
				return;
			}
			event.preventDefault();
			setView((current) => (current === "classic" ? "timeline" : "classic"));
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [hovering]);

	const nodes = useMemo(
		() =>
			view === "timeline"
				? layoutDemoNodes(DEMO_COMMENTS, FULL_WINDOW, width, MIN_NODE_GAP)
				: [],
		[view, width],
	);

	const shelfHeight =
		nodes.length > 0
			? Math.max(...nodes.map((node) => LANE_STEM[node.lane])) +
				NODE_SIZE / 2 +
				12
			: 0;

	return (
		<DemoPanel
			title="One player, two views"
			hint="Flip between them. With your pointer over this demo you can also just press T, the way you would on a Cap link."
			caption="The blue markers are recorded replies: a screen recording, a voice note and a camera clip. The video element never reloads, so the position, the volume and a running playback survive the switch."
		>
			<div
				ref={containerRef}
				onPointerEnter={() => setHovering(true)}
				onPointerLeave={() => setHovering(false)}
			>
				<motion.div
					layout={!reduceMotion}
					transition={
						reduceMotion
							? { duration: 0 }
							: { type: "spring", stiffness: 260, damping: 32 }
					}
					className="overflow-hidden rounded-xl border border-gray-4 bg-white"
				>
					{view === "timeline" && (
						<div className="flex h-12 items-center justify-between gap-3 border-b border-gray-4 px-3 sm:px-4">
							<div className="flex min-w-0 items-center gap-2">
								<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-blue-9 text-[11px] font-medium text-white">
									R
								</span>
								<span className="truncate text-[13px] font-medium text-gray-12">
									Q3 walkthrough
								</span>
							</div>
							<ShareViewToggle view={view} onChange={setView} />
						</div>
					)}

					<div className="relative aspect-video bg-[hsl(224,71.4%,4.1%)]">
						<MockFrame
							time={clock.time}
							className="absolute inset-0 size-full"
						/>

						{view === "classic" && (
							<>
								<div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-black/60 to-transparent" />
								<div className="absolute inset-x-0 bottom-0 flex items-center gap-2 px-2 pb-2 sm:px-3 sm:pb-3">
									<TransportButton
										playing={clock.playing}
										onClick={clock.toggle}
										tone="dark"
									/>
									<PlainSeekBar
										time={clock.time}
										onSeek={(t) => {
											clock.pause();
											clock.seek(t);
										}}
										tone="dark"
									/>
									<Clock time={clock.time} tone="dark" />
								</div>
							</>
						)}
					</div>

					{view === "timeline" && (
						<>
							<div ref={stripRef}>
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
							<div className="relative" style={{ height: shelfHeight }}>
								{nodes.length > 0 && <AnchorLine />}
								{nodes.map((node, index) => (
									<BranchNode
										key={node.comment.id}
										node={node}
										delay={index * 0.04}
										onSelect={() => {
											clock.pause();
											clock.seek(node.comment.t);
										}}
									/>
								))}
							</div>
							<div className="flex items-center gap-2 border-t border-gray-4 px-2 py-2 sm:px-3">
								<TransportButton
									playing={clock.playing}
									onClick={clock.toggle}
								/>
								<span className="flex-1" />
								<Clock time={clock.time} />
							</div>
						</>
					)}
				</motion.div>

				{view === "classic" && (
					<div className="mt-3 flex items-center gap-3">
						<ShareViewToggle view={view} onChange={setView} />
						<span className="text-[13px] text-gray-10">
							Or press <Key>T</Key>
						</span>
					</div>
				)}
			</div>
		</DemoPanel>
	);
}

function Key({ children }: { children: React.ReactNode }) {
	return (
		<span className="inline-flex h-5 min-w-5 items-center justify-center rounded border border-gray-5 bg-gray-2 px-1 font-mono text-[11px] text-gray-12">
			{children}
		</span>
	);
}
