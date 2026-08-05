"use client";

import { useState } from "react";
import { Clock, CommentRow, PlainSeekBar, TransportButton } from "./DemoBits";
import { DemoPanel } from "./DemoPanel";
import { MockFrame } from "./MockFrame";
import { DEMO_COMMENTS } from "./scene";
import { useDemoClock } from "./useDemoClock";

/**
 * Where everyone starts: a video, a seek bar, and the feedback parked in a
 * sidebar next to it. Everything works. Nothing about the bar tells you that
 * three of the six comments land within six seconds of each other.
 */
export function ListDemo() {
	const clock = useDemoClock({ initial: 12 });
	const [activeId, setActiveId] = useState<string | null>(null);

	return (
		<DemoPanel
			title="The list you already have"
			hint="Click a comment to jump to it. Then, from the bar alone, try to tell where the other five are."
			caption="Every comment is a number you have to go and check. The bar is 168 seconds of nothing, and the sidebar is sorted by time, which is only useful once you already know what happened when."
		>
			<div className="flex flex-col gap-4 lg:flex-row">
				<div className="min-w-0 flex-1">
					<div className="overflow-hidden rounded-xl bg-[hsl(224,71.4%,4.1%)]">
						<div className="relative aspect-video">
							<MockFrame
								time={clock.time}
								className="absolute inset-0 size-full"
							/>
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
										setActiveId(null);
									}}
									tone="dark"
								/>
								<Clock time={clock.time} tone="dark" />
							</div>
						</div>
					</div>
				</div>

				<div className="shrink-0 rounded-xl border border-gray-4 bg-gray-1 p-1.5 lg:w-72">
					<div className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-[0.08em] text-gray-10">
						Comments · {DEMO_COMMENTS.length}
					</div>
					<div className="flex flex-col">
						{DEMO_COMMENTS.map((comment) => (
							<CommentRow
								key={comment.id}
								comment={comment}
								active={activeId === comment.id}
								onClick={() => {
									clock.pause();
									clock.seek(comment.t);
									setActiveId(comment.id);
								}}
							/>
						))}
					</div>
				</div>
			</div>
		</DemoPanel>
	);
}
