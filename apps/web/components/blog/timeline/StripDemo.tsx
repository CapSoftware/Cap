"use client";

import { useState } from "react";
import { Clock, TransportButton } from "./DemoBits";
import { DemoPanel } from "./DemoPanel";
import { DemoPlayhead, DemoStrip } from "./DemoStrip";
import { MockFrame } from "./MockFrame";
import { clamp, DEMO_DURATION, formatClock } from "./scene";
import { useDemoClock } from "./useDemoClock";

/**
 * The same bar, with the video's own frames in it. Hovering previews without
 * committing — the product's hover ghost — and dragging scrubs.
 */
export function StripDemo() {
	const clock = useDemoClock({ initial: 30 });
	const [hover, setHover] = useState<number | null>(null);

	return (
		<DemoPanel
			title="The strip"
			hint="Drag across the film. On a mouse, hover it first: the preview follows without moving the video."
			caption="Same 168 seconds, same pixel width. The difference is that you can now see the dialog open, and you can aim at it."
		>
			<div className="overflow-hidden rounded-xl border border-gray-4">
				<div className="relative aspect-video bg-[hsl(224,71.4%,4.1%)]">
					<MockFrame time={clock.time} className="absolute inset-0 size-full" />
				</div>

				<div className="relative">
					<DemoStrip
						time={clock.time}
						waveform={false}
						onSeek={(t) => {
							clock.pause();
							clock.seek(t);
						}}
						onHoverTime={setHover}
						label="Scrub the recording"
					>
						<DemoPlayhead time={clock.time} />
					</DemoStrip>

					{hover !== null && (
						<div
							className="pointer-events-none absolute bottom-full z-30 mb-2 w-32 -translate-x-1/2 sm:w-40"
							style={{
								left: `clamp(4.5rem, ${(
									clamp(hover / DEMO_DURATION, 0, 1) * 100
								).toFixed(2)}%, 100% - 4.5rem)`,
							}}
						>
							<div className="overflow-hidden rounded-lg border border-gray-5 bg-white shadow-[0_8px_24px_rgba(18,22,31,0.18)]">
								<div className="relative aspect-video">
									<MockFrame
										time={hover}
										className="absolute inset-0 size-full"
									/>
								</div>
								<div className="px-2 py-1 text-center font-mono text-[11px] tabular-nums text-gray-11">
									{formatClock(hover)}
								</div>
							</div>
						</div>
					)}
				</div>

				<div className="flex items-center gap-2 border-t border-gray-4 bg-white px-2 py-2 sm:px-3">
					<TransportButton playing={clock.playing} onClick={clock.toggle} />
					<span className="flex-1" />
					<Clock time={clock.time} />
				</div>
			</div>
		</DemoPanel>
	);
}
