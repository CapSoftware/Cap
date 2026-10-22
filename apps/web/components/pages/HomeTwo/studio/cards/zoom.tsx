"use client";

import { useRef } from "react";
import { LucideSearch } from "../../demo/capIcons";
import {
	easeInOut,
	span,
	useCursor,
	useSceneState,
	type Way,
} from "../../scenes/engine";
import {
	CANVAS,
	ED,
	Field,
	Ground,
	HUE,
	Lane,
	Panel,
	Playhead,
	RecordedWindow,
	Segment,
	Segmented,
	Slider,
	TRACK_GUTTER,
	TrackLabel,
	useLoop,
} from "../shared";

const WIN = { left: 196, top: 18, scale: 1.05 };
const FOCUS = { x: WIN.left + 300 * WIN.scale, y: WIN.top + 74 * WIN.scale };
const FRAME_H = 292;
const CLICK_AT = 1500;
const ZOOM_IN = { start: 1600, end: 2500 };
const ZOOM_OUT = { start: 5200, end: 6100 };
const DURATION = 8000;
const AMOUNT = 1.5;
const PANEL = { left: 16, top: 18, w: 150, scale: 1.15 };

const PATH: Way[] = [
	{ t: 0, x: 330, y: 226 },
	{ t: 1400, ...FOCUS },
	{ t: CLICK_AT, ...FOCUS, click: true },
	{ t: 3400, ...FOCUS },
	{ t: 4600, x: FOCUS.x - 30, y: FOCUS.y + 44 },
	{ t: DURATION, x: FOCUS.x - 30, y: FOCUS.y + 44 },
];

const scaleAt = (t: number) =>
	1 +
	(AMOUNT - 1) *
		(easeInOut(span(t, ZOOM_IN.start, ZOOM_IN.end)) -
			easeInOut(span(t, ZOOM_OUT.start, ZOOM_OUT.end)));

const S = 1.3;
const LOGICAL = { w: CANVAS.w / S, h: CANVAS.h / S };
const STRIP = { left: 12, top: 226, pad: 8 };
const STRIP_W = LOGICAL.w - STRIP.left * 2;
const LANE_W = STRIP_W - STRIP.pad * 2 - TRACK_GUTTER;
const SEGMENT = { left: 0.16, width: 0.56 };

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const zoomRef = useRef<HTMLDivElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState({ segment: false });
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 3600,
		tick: (t, seek) => {
			setUi({ segment: t >= CLICK_AT });
			if (zoomRef.current) {
				zoomRef.current.style.transform = `scale(${scaleAt(t)})`;
			}
			if (playheadRef.current) {
				playheadRef.current.style.transform = `translateX(${(t / DURATION) * LANE_W}px)`;
			}
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="light">
				<div
					className="absolute inset-x-0 top-0 overflow-hidden"
					style={{ height: FRAME_H }}
				>
					<div
						ref={zoomRef}
						className="absolute inset-0 will-change-transform"
						style={{ transformOrigin: `${FOCUS.x}px ${FOCUS.y}px` }}
					>
						<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />
					</div>
				</div>

				<div
					className="absolute transition-[opacity,transform] duration-300"
					style={{
						left: PANEL.left,
						top: PANEL.top,
						width: PANEL.w,
						transform: `scale(${PANEL.scale}) translateY(${ui.segment ? 0 : 6}px)`,
						transformOrigin: "top left",
						opacity: ui.segment ? 1 : 0,
					}}
				>
					<Panel className="left-0 top-0 w-full gap-3">
						<Field label="Zoom 1" value="1.50x">
							<Slider fill={(AMOUNT - 1) / 3.5} />
						</Field>
						<Field label="Zoom Mode">
							<Segmented options={["Auto", "Manual"]} value="Auto" />
						</Field>
					</Panel>
				</div>

				<div
					className="absolute left-0 top-0"
					style={{
						width: LOGICAL.w,
						height: LOGICAL.h,
						transform: `scale(${S})`,
						transformOrigin: "top left",
					}}
				>
					<div
						className="absolute flex rounded-xl"
						style={{
							left: STRIP.left,
							top: STRIP.top,
							width: STRIP_W,
							padding: STRIP.pad,
							background: ED.card,
							boxShadow: ED.cardShadow,
						}}
					>
						<TrackLabel
							hue={HUE.zoom}
							icon={<LucideSearch className="size-3.5" />}
						>
							Zoom
						</TrackLabel>
						<Lane
							empty={
								ui.segment ? undefined : (
									<>
										<span>Generate zoom segments automatically</span>
										<span style={{ color: ED.text2 }}>· Generate</span>
									</>
								)
							}
						>
							<Segment
								hue={HUE.zoom}
								label="Automatic Zoom"
								sublabel="1.5x"
								selected
								className="transition-[opacity,transform] duration-300"
								style={{
									left: `${SEGMENT.left * 100}%`,
									width: `${SEGMENT.width * 100}%`,
									opacity: ui.segment ? 1 : 0,
									transform: ui.segment ? "scaleX(1)" : "scaleX(0.6)",
									transformOrigin: "left center",
								}}
							/>
							<Playhead playheadRef={playheadRef} top={-6} bottom={0} />
						</Lane>
					</div>
				</div>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
