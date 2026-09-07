"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { CapAudioOn, CapClapperboard, LucidePlus } from "../../demo/capIcons";
import {
	easeInOut,
	lerp,
	span,
	useCursor,
	useSceneState,
	type Way,
} from "../../scenes/engine";
import {
	CANVAS,
	ED,
	Ground,
	HUE,
	Lane,
	mix,
	Playhead,
	RULER_H,
	Ruler,
	Segment,
	SpeedChip,
	TRACK_GAP,
	TRACK_GUTTER,
	TRACK_H,
	TrackLabel,
	useLoop,
	Waveform,
} from "../shared";

const S = 1.5;
const LOGICAL = { w: CANVAS.w / S, h: CANVAS.h / S };
const INSET = 14;
const PAD = 12;
const CARD = {
	x: INSET,
	w: LOGICAL.w - INSET * 2,
	h: 10 + RULER_H + TRACK_GAP + TRACK_H + TRACK_GAP + TRACK_H + PAD,
};
const CARD_Y = Math.round((LOGICAL.h - CARD.h) / 2) + 4;
const LANE_X = CARD.x + PAD + TRACK_GUTTER;
const LANE_W = CARD.w - PAD * 2 - TRACK_GUTTER;
const VIDEO_Y = CARD_Y + 10 + RULER_H + TRACK_GAP;
const AUDIO_Y = VIDEO_Y + TRACK_H + TRACK_GAP;

const DURATION = 10000;
const CLIP_A = {
	start: Math.round(LANE_W * 0.48),
	trimmed: Math.round(LANE_W * 0.38),
};
const CLIP_B = {
	start: Math.round(LANE_W * 0.44),
	fast: Math.round(LANE_W * 0.32),
};
const JOIN = 4;
const TRIM = { start: 2200, end: 3400 };
const SPEED_AT = 3900;
const FADE_AT = 5200;
const AUDIO_AT = 6400;

const g = (x: number, y: number) => ({ x: x * S, y: y * S });
const mid = VIDEO_Y + TRACK_H / 2;

const PATH: Way[] = [
	{ t: 0, ...g(LANE_X + 40, CARD_Y - 6) },
	{ t: 1900, ...g(LANE_X + CLIP_A.start + 1, mid) },
	{ t: TRIM.start, ...g(LANE_X + CLIP_A.start + 1, mid) },
	{ t: TRIM.end, ...g(LANE_X + CLIP_A.trimmed + 1, mid) },
	{
		t: SPEED_AT - 150,
		...g(LANE_X + CLIP_A.trimmed + JOIN + CLIP_B.start - 22, mid),
	},
	{
		t: SPEED_AT,
		...g(LANE_X + CLIP_A.trimmed + JOIN + CLIP_B.start - 22, mid),
		click: true,
	},
	{ t: FADE_AT - 150, ...g(LANE_X + CLIP_A.trimmed + JOIN / 2, mid) },
	{ t: FADE_AT, ...g(LANE_X + CLIP_A.trimmed + JOIN / 2, mid), click: true },
	{ t: AUDIO_AT + 400, ...g(LANE_X + LANE_W - 24, AUDIO_Y + TRACK_H + 14) },
	{ t: DURATION, ...g(LANE_X + LANE_W - 24, AUDIO_Y + TRACK_H + 14) },
];

const uiAt = (t: number) => ({
	trimmed: t >= TRIM.start + 400,
	speed: t >= SPEED_AT,
	fade: t >= FADE_AT,
	audio: t >= AUDIO_AT,
});

const widthsAt = (t: number) => {
	const trim = easeInOut(span(t, TRIM.start, TRIM.end));
	const a = lerp(CLIP_A.start, CLIP_A.trimmed, trim);
	const b = t >= SPEED_AT ? CLIP_B.fast : CLIP_B.start;
	return { a, b };
};

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const clipARef = useRef<HTMLDivElement | null>(null);
	const clipBRef = useRef<HTMLDivElement | null>(null);
	const seamRef = useRef<HTMLDivElement | null>(null);
	const playheadRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 7200,
		tick: (t, seek) => {
			setUi(uiAt(t));
			const { a, b } = widthsAt(t);
			if (clipARef.current) clipARef.current.style.width = `${a}px`;
			if (clipBRef.current) {
				clipBRef.current.style.left = `${a + JOIN}px`;
				clipBRef.current.style.width = `${b}px`;
			}
			if (seamRef.current) seamRef.current.style.left = `${a - 6}px`;
			const frac = (t % 3200) / 3200;
			const split = t >= SPEED_AT ? 0.66 : a / (a + b);
			const head =
				frac < split
					? lerp(0, a, frac / split)
					: lerp(a + JOIN, a + JOIN + b, (frac - split) / (1 - split));
			if (playheadRef.current) {
				playheadRef.current.style.transform = `translateX(${head}px)`;
			}
			cursor.tick(PATH, t, seek);
		},
	});

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="chrome">
				<div
					className="absolute left-0 top-0"
					style={{
						width: LOGICAL.w,
						height: LOGICAL.h,
						transform: `scale(${S})`,
						transformOrigin: "top left",
					}}
				>
					<span
						className="absolute left-1/2 h-1 w-9 -translate-x-1/2 rounded-full"
						style={{ top: CARD_Y - 12, background: ED.lineStrong }}
					/>
					<div
						className="absolute rounded-xl"
						style={{
							left: CARD.x,
							top: CARD_Y,
							width: CARD.w,
							height: CARD.h,
							background: ED.card,
							boxShadow: ED.cardShadow,
						}}
					/>

					<div
						className="absolute flex items-end"
						style={{
							left: CARD.x + PAD,
							top: CARD_Y + 10,
							width: CARD.w - PAD * 2,
						}}
					>
						<div
							className="flex shrink-0 items-end pb-1"
							style={{ width: TRACK_GUTTER }}
						>
							<span
								className="inline-flex h-6 items-center gap-1 rounded-md pl-1.5 pr-2 text-[12px] font-medium"
								style={{ background: ED.ctl, color: ED.text2 }}
							>
								<LucidePlus className="size-3" />
								Add track
							</span>
						</div>
						<Ruler
							labels={["0:00", "0:05", "0:10", "0:15", "0:20", "0:25"]}
							span={5.6}
						/>
					</div>

					<div
						className="absolute flex"
						style={{
							left: CARD.x + PAD,
							top: VIDEO_Y,
							width: CARD.w - PAD * 2,
						}}
					>
						<TrackLabel
							hue={HUE.clip}
							icon={<CapClapperboard className="size-3.5" />}
						>
							Clip
						</TrackLabel>
						<Lane>
							<Segment
								hue={HUE.clip}
								segmentRef={clipARef}
								label="Clip 1"
								sublabel={ui.trimmed ? undefined : "0:14"}
								trailing={<SpeedChip>1x</SpeedChip>}
								style={{ left: 0, width: CLIP_A.start }}
							>
								<Waveform from={0} to={34} />
							</Segment>
							<Segment
								hue={HUE.clip}
								segmentRef={clipBRef}
								label="Clip 2"
								sublabel={ui.speed ? undefined : "0:10"}
								trailing={
									<SpeedChip active={ui.speed}>
										{ui.speed ? "2x" : "1x"}
									</SpeedChip>
								}
								style={{ left: CLIP_A.start + JOIN, width: CLIP_B.start }}
							>
								<Waveform from={18} to={44} />
							</Segment>
							<div
								ref={seamRef}
								className={classNames(
									"pointer-events-none absolute inset-y-0 w-4 rounded-sm border-x transition-opacity duration-300",
									ui.fade ? "opacity-100" : "opacity-0",
								)}
								style={{
									left: CLIP_A.start - 6,
									borderColor: mix(ED.accent, 60, "transparent"),
									background: `repeating-linear-gradient(135deg, ${mix(ED.accent, 22, "transparent")} 0 3px, transparent 3px 6px)`,
								}}
							>
								<span
									className="absolute -top-[26px] left-1/2 -translate-x-1/2 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[10px] font-medium"
									style={{
										background: ED.card,
										color: ED.text1,
										boxShadow: ED.popShadow,
									}}
								>
									Crossfade · 0.5s
								</span>
							</div>
						</Lane>
					</div>

					<div
						className="absolute flex"
						style={{
							left: CARD.x + PAD,
							top: AUDIO_Y,
							width: CARD.w - PAD * 2,
						}}
					>
						<TrackLabel
							hue={HUE.audio}
							icon={<CapAudioOn className="size-3.5" />}
						>
							Audio
						</TrackLabel>
						<Lane
							empty={ui.audio ? undefined : "Add audio, music or other sounds"}
						>
							<Segment
								hue={HUE.audio}
								label="Lofi Beats"
								sublabel="24s"
								className={classNames(
									"transition-[opacity,transform] duration-500",
									ui.audio
										? "translate-y-0 opacity-100"
										: "translate-y-1 opacity-0",
								)}
								style={{ left: 0, width: LANE_W * 0.92 }}
							>
								<svg
									aria-hidden="true"
									className="pointer-events-none absolute inset-0 h-full w-full"
									viewBox="0 0 100 44"
									preserveAspectRatio="none"
								>
									<path
										d="M0 44 L0 40 L8 8 L92 8 L100 40 L100 44 Z"
										fill={mix(HUE.audio, 10, "transparent")}
									/>
									<path
										d="M0 40 L8 8 L92 8 L100 40"
										fill="none"
										stroke={mix(HUE.audio, 55, "transparent")}
										strokeWidth="1"
										vectorEffect="non-scaling-stroke"
									/>
								</svg>
								<Waveform color={mix(HUE.audio, 40, "transparent")} />
							</Segment>
						</Lane>
					</div>

					<div
						className="pointer-events-none absolute"
						style={{ left: LANE_X, top: VIDEO_Y - 12, width: LANE_W }}
					>
						<Playhead
							playheadRef={playheadRef}
							top={0}
							bottom={-(TRACK_H * 2 + TRACK_GAP + 12)}
						/>
					</div>
				</div>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
