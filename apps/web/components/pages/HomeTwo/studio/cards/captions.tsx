"use client";

import { classNames } from "@cap/utils/helpers";
import { useRef } from "react";
import { LucideChevronDown } from "../../demo/capIcons";
import { useCursor, useSceneState, type Way } from "../../scenes/engine";
import {
	ED,
	EditorButton,
	Field,
	Ground,
	Panel,
	RecordedWindow,
	Toggle,
	useLoop,
} from "../shared";

/* Captions, generated locally: the caption itself is the hero, with the
 * active word highlighted the way the Karaoke style does it. The Captions
 * tab beside it is the real one: a local model, a language, Generate. */

const WIN = { left: 10, top: 38, scale: 1.12 };
const PANEL = { left: 368, top: 12, w: 196, scale: 1.1 };
const LINES = [
	{ start: 500, words: "Here is the new dashboard".split(" ") },
	{ start: 4400, words: "Every card pulls live data".split(" ") },
];
const WORD_MS = 380;
const TOGGLE_AT = 7600;
const DURATION = 9000;
const TOGGLE = {
	x: PANEL.left + 151 * PANEL.scale,
	y: PANEL.top + 283 * PANEL.scale,
};

const PATH: Way[] = [
	{ t: 0, x: 300, y: 190 },
	{ t: 6400, x: 300, y: 190 },
	{ t: 7300, ...TOGGLE },
	{ t: TOGGLE_AT, ...TOGGLE, click: true },
	{ t: 8400, x: TOGGLE.x - 40, y: TOGGLE.y + 60 },
	{ t: DURATION, x: TOGGLE.x - 40, y: TOGGLE.y + 60 },
];

const uiAt = (t: number) => {
	let line = 0;
	for (let i = 0; i < LINES.length; i++) {
		if (t >= (LINES[i]?.start ?? 0)) line = i;
	}
	const current = LINES[line];
	const elapsed = t - (current?.start ?? 0);
	const active = Math.min(
		(current?.words.length ?? 1) - 1,
		Math.floor(Math.max(0, elapsed) / WORD_MS),
	);
	return {
		line,
		active,
		shown: t >= (LINES[0]?.start ?? 0),
		exportOn: t >= TOGGLE_AT,
	};
};

const SelectBox = ({
	children,
	sub,
	right,
}: {
	children: React.ReactNode;
	sub?: string;
	right?: string;
}) => (
	<div
		className="flex items-center justify-between gap-2 rounded-lg px-2.5"
		style={{
			minHeight: sub ? 44 : 32,
			boxShadow: `inset 0 0 0 1px ${ED.lineStrong}`,
			background: ED.card,
		}}
	>
		<span className="flex min-w-0 flex-col leading-tight">
			<span className="text-[13px]" style={{ color: ED.text1 }}>
				{children}
			</span>
			{sub ? (
				<span
					className="whitespace-nowrap text-[10px]"
					style={{ color: ED.text3 }}
				>
					{sub}
				</span>
			) : null}
		</span>
		<span className="flex shrink-0 items-center gap-1.5">
			{right ? (
				<span className="text-[11px] tabular-nums" style={{ color: ED.text3 }}>
					{right}
				</span>
			) : null}
			<LucideChevronDown className="size-3.5" style={{ color: ED.text3 }} />
		</span>
	</div>
);

export const Visual = ({ playing }: { playing: boolean }) => {
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [ui, setUi] = useSceneState(uiAt(0));
	const cursor = useCursor(rootRef);

	useLoop({
		duration: DURATION,
		playing,
		pose: 2200,
		tick: (t, seek) => {
			setUi(uiAt(t));
			cursor.tick(PATH, t, seek);
		},
	});

	const line = LINES[ui.line] ?? LINES[0];

	return (
		<div ref={rootRef} className="relative">
			<Ground tone="light">
				<RecordedWindow left={WIN.left} top={WIN.top} scale={WIN.scale} />
				<div
					className="pointer-events-none absolute rounded-[10px]"
					style={{
						left: WIN.left,
						top: WIN.top,
						width: 360 * WIN.scale,
						height: 250 * WIN.scale,
						background: "rgba(9,12,20,0.16)",
					}}
				/>

				<div
					className="absolute z-20 flex items-center gap-x-1.5 whitespace-nowrap rounded-xl px-4 py-2 transition-opacity duration-300"
					style={{
						left: 22,
						top: 299,
						background: "rgba(17,17,17,0.74)",
						opacity: ui.shown ? 1 : 0,
					}}
				>
					{line?.words.map((word, i) => (
						<span
							key={`${ui.line}-${word}-${i}`}
							className={classNames(
								"rounded-md px-1.5 py-1 text-[20px] font-medium leading-none",
								i === ui.active ? "text-white" : "text-white/90",
							)}
							style={{ background: i === ui.active ? ED.accent : undefined }}
						>
							{word}
						</span>
					))}
				</div>

				<div
					className="absolute z-30"
					style={{
						left: PANEL.left,
						top: PANEL.top,
						width: PANEL.w,
						transform: `scale(${PANEL.scale})`,
						transformOrigin: "top left",
					}}
				>
					<Panel className="left-0 top-0 w-full gap-3">
						<div className="flex min-h-[22px] items-center gap-1.5">
							<span
								className="text-[12px] font-medium"
								style={{ color: ED.text2 }}
							>
								Captions
							</span>
							<span
								className="rounded-full px-1.5 py-0.5 text-[10px] font-medium"
								style={{ background: ED.ctl, color: ED.text2 }}
							>
								Beta
							</span>
						</div>
						<Field label="Model">
							<SelectBox sub="parakeet-tdt-0.6b-v3 int8" right="~640MB">
								Recommended
							</SelectBox>
						</Field>
						<Field label="Language">
							<SelectBox>English</SelectBox>
						</Field>
						<EditorButton primary className="w-full justify-center">
							Generate Captions
						</EditorButton>
						<div className="flex items-center justify-between gap-3 pt-1">
							<span
								className="text-[13px] leading-tight"
								style={{ color: ED.text1 }}
							>
								Export with Subtitles
							</span>
							<Toggle on={ui.exportOn} />
						</div>
					</Panel>
				</div>
				{cursor.Cursor}
			</Ground>
		</div>
	);
};
