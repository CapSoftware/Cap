"use client";

import { useDetectPlatform } from "hooks/useDetectPlatform";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	InstantIcon,
	ScreenshotIcon,
	StudioIcon,
} from "@/components/pages/HomePage/modeIcons";
import { MacCursor, WindowsCursor } from "./cursors";
import { H_HERO, INK, MODE_THEME, type ModeKey } from "./theme";

/**
 * The hero headline is a three-slot machine: capture verb, middle beat,
 * payoff. The slots keep their rhythm while the words are revised, so one
 * sentence re-reads as a different mode.
 *
 *   Record.       Edit.        Share.           (at rest)
 *   Record.       Stop.        Instant Share.   (Instant)
 *   Record.       Edit.        Export.          (Studio)
 *   Screenshot.   Beautify.    Paste.           (Screenshot)
 *
 * Nothing moves on its own: the mode bar sits above the line from the first
 * paint with a cursor leaning in beside it, and you click a mode to watch
 * the line get revised. The revision is staged like an edit on paper: a rule
 * strikes through the word in the incoming mode's colour, the struck word
 * lifts away, and the replacement rises into the gap while the slot width
 * glides so the line re-centres. Words that survive the change are never
 * struck, so you see exactly what the mode changes, which is why Studio only
 * crosses out the last word.
 */

type SlideKey = ModeKey | "all";

type Slide = {
	key: SlideKey;
	/** [capture, middle, payoff] */
	words: [string, string, string];
};

const SLIDES: Slide[] = [
	{ key: "all", words: ["Record.", "Edit.", "Share."] },
	{ key: "instant", words: ["Record.", "Stop.", "Instant Share."] },
	{ key: "studio", words: ["Record.", "Edit.", "Export."] },
	{ key: "screenshot", words: ["Screenshot.", "Beautify.", "Paste."] },
];

/** The cursor's one line: it invites the click, then retires once you take it. */
const NUDGE = "Click me \u{1F440}";
const NUDGE_TOUCH = "Tap me \u{1F440}";
const TOUCH_QUERY = "(max-width: 767px)";
const TYPE_MS = 26;
/** The cursor leans in first, then starts talking. */
const NUDGE_AT = 520;
const TYPE_AT = NUDGE_AT + 260;

type PillKey = Extract<ModeKey, "instant" | "studio" | "screenshot">;

const PILLS: { key: PillKey; label: string; short: string; slide: number }[] = [
	{ key: "instant", label: "Instant Mode", short: "Instant", slide: 1 },
	{ key: "studio", label: "Studio Mode", short: "Studio", slide: 2 },
	{
		key: "screenshot",
		label: "Screenshot Mode",
		short: "Screenshot",
		slide: 3,
	},
];

const PILL_ICON = {
	instant: InstantIcon,
	studio: StudioIcon,
	screenshot: ScreenshotIcon,
} as const;

/* --------------------------------------------------------------- timing -- */

/** Per-slot head start, so the revision runs left to right down the line. */
const SLOT_DELAY = [0, 120, 240];
/** Rule sweeps across the word. */
const STRIKE_MS = 260;
/** Beat where the struck word just sits there, crossed out. */
const HOLD_MS = 110;
/** Struck word (and its rule) lift away. */
const LIFT_MS = 260;
/** Replacement rises in, overlapping the lift so the two read as one move. */
const RISE_MS = 520;

const LIFT_AT = STRIKE_MS + HOLD_MS;
const RISE_AT = LIFT_AT + 150;
const WIDTH_AT = LIFT_AT + 60;

/* ------------------------------------------------------------------ slot -- */

type Departing = { text: string; color: string; id: number };

type Swap = { text: string; gen: number; from: Departing | null };

const Slot = ({
	text,
	color,
	strike,
	delay,
	animate,
}: {
	text: string;
	/** Ink for most slots, the mode's colour for the payoff. */
	color: string;
	/** Colour of the cross-out rule: the incoming mode's. */
	strike: string;
	delay: number;
	animate: boolean;
}) => {
	const ghostRef = useRef<HTMLSpanElement>(null);
	const [width, setWidth] = useState<number>();
	// The swap has to be derived during render, not in an effect: the exit
	// layer, the remount key and the enter animation all have to appear in
	// the same commit as the new word, or the replacement pops in unanimated.
	const [swap, setSwap] = useState<Swap>(() => ({
		text,
		gen: 0,
		from: null,
	}));
	// Holds the colour the slot was painted in for the word now leaving.
	const paintedColor = useRef(color);

	if (swap.text !== text) {
		setSwap({
			text,
			gen: swap.gen + 1,
			// A word that survives the mode change is never struck out: it just
			// stays put while its neighbours are revised around it.
			from: animate
				? { text: swap.text, color: paintedColor.current, id: swap.gen + 1 }
				: null,
		});
	}

	useEffect(() => {
		paintedColor.current = color;
	}, [color]);

	const measure = useCallback(() => {
		const el = ghostRef.current;
		if (el) setWidth(el.getBoundingClientRect().width);
	}, []);

	// The ghost is in flow and invisible, so it always carries the natural
	// width of whatever the slot is currently showing. Remeasure when the
	// word, the loaded fonts, or the clamped font size changes.
	// biome-ignore lint/correctness/useExhaustiveDependencies: remeasure on word change
	useEffect(() => {
		measure();
	}, [measure, text]);

	useEffect(() => {
		window.addEventListener("resize", measure);
		document.fonts?.ready.then(measure).catch(() => {});
		return () => window.removeEventListener("resize", measure);
	}, [measure]);

	// Retire the struck word once it has finished lifting. The enter class is
	// left in place (it fills forwards) so the timer can't clip the rise.
	const departingId = swap.from?.id;
	useEffect(() => {
		if (departingId === undefined) return;
		const timer = window.setTimeout(
			() =>
				setSwap((s) => (s.from?.id === departingId ? { ...s, from: null } : s)),
			delay + LIFT_AT + LIFT_MS + 40,
		);
		return () => window.clearTimeout(timer);
	}, [departingId, delay]);

	const entering = animate && swap.gen > 0;

	return (
		<span
			className="ht-slot"
			style={{
				width,
				color,
				transitionDelay: `${delay + WIDTH_AT}ms`,
			}}
		>
			{/* Sets the slot's height and its natural (target) width. */}
			<span ref={ghostRef} className="ht-slot-ghost" aria-hidden="true">
				{text}
			</span>

			{swap.from ? (
				<span key={`out-${swap.from.id}`} className="ht-layer">
					<span
						className="ht-out"
						style={{
							color: swap.from.color,
							animationDelay: `${delay + LIFT_AT}ms`,
						}}
					>
						{swap.from.text}
						<span
							className="ht-strike"
							style={{ background: strike, animationDelay: `${delay}ms` }}
						/>
					</span>
				</span>
			) : null}

			<span key={`in-${swap.gen}`} className="ht-layer">
				<span
					className={entering ? "ht-in" : undefined}
					style={
						entering ? { animationDelay: `${delay + RISE_AT}ms` } : undefined
					}
				>
					{text}
				</span>
			</span>
		</span>
	);
};

/* -------------------------------------------------------------- headline -- */

export const HeroHeadline = () => {
	const { platform } = useDetectPlatform();
	const [index, setIndex] = useState(0);
	const [typed, setTyped] = useState(0);
	const [nudgeText, setNudgeText] = useState(NUDGE);
	const [nudge, setNudge] = useState(false);
	const [asked, setAsked] = useState(true);
	const [reduced, setReduced] = useState(false);

	// Match the download button: assume macOS while detection resolves, so the
	// arrow never swaps shape under the reader.
	const Arrow = platform === "windows" ? WindowsCursor : MacCursor;

	useEffect(() => {
		const query = window.matchMedia("(prefers-reduced-motion: reduce)");
		const sync = () => setReduced(query.matches);
		sync();
		query.addEventListener("change", sync);
		return () => query.removeEventListener("change", sync);
	}, []);

	// The cursor leans in, then types its line. Reduced motion gets both at
	// once, already finished.
	useEffect(() => {
		const text = window.matchMedia(TOUCH_QUERY).matches ? NUDGE_TOUCH : NUDGE;
		setNudgeText(text);
		if (reduced) {
			setNudge(true);
			setTyped(text.length);
			return;
		}
		const lean = window.setTimeout(() => setNudge(true), NUDGE_AT);
		let tick = 0;
		const start = window.setTimeout(() => {
			tick = window.setInterval(() => {
				setTyped((n) => {
					if (n + 1 >= text.length) window.clearInterval(tick);
					return n + 1;
				});
			}, TYPE_MS);
		}, TYPE_AT);
		return () => {
			window.clearTimeout(lean);
			window.clearTimeout(start);
			window.clearInterval(tick);
		};
	}, [reduced]);

	const slide = SLIDES[index] ?? SLIDES[0];
	if (!slide) return null;
	const theme = slide.key === "all" ? null : MODE_THEME[slide.key];
	const accent = theme ? theme.glyph : INK;

	// Clicking the mode you're already on puts the plain line back, so you can
	// always see what Cap changed.
	const pick = (target: number) => {
		setIndex((current) => (current === target ? 0 : target));
		// The cursor and its bubble have done their job the moment you click.
		setAsked(false);
	};

	return (
		<div className="flex w-full flex-col items-center">
			<style href="ht-hero-headline" precedence="default">
				{CSS}
			</style>

			<div className="relative pb-10 md:pb-14">
				<div className="mx-auto flex w-fit flex-nowrap items-center justify-center gap-0.5 rounded-full border border-[#DDE4EB] bg-white/70 p-1 shadow-[0_1px_2px_rgba(17,17,17,0.04)]">
					{PILLS.map((pill) => {
						const active = index === pill.slide;
						const pillTheme = MODE_THEME[pill.key];
						const Icon = PILL_ICON[pill.key];
						return (
							<button
								key={pill.key}
								type="button"
								onClick={() => pick(pill.slide)}
								aria-pressed={active}
								className={`flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 transition-colors duration-300 sm:px-3 ${
									active
										? "text-[#111111]"
										: "text-[rgba(17,17,17,0.5)] hover:bg-[#EDF1F6] hover:text-[#111111]"
								} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#111111] focus-visible:ring-offset-1 focus-visible:ring-offset-white`}
								style={active ? { background: pillTheme.chip } : undefined}
							>
								<Icon className="size-3.5" />
								<span className="text-[13px] font-medium leading-none">
									<span className="sm:hidden">{pill.short}</span>
									<span className="hidden sm:inline">{pill.label}</span>
								</span>
							</button>
						);
					})}
				</div>

				{/* Nothing cycles on its own, so the cursor is what says the line is
				    yours to change. It retires as soon as you take it up on the
				    offer. */}
				<span
					aria-hidden="true"
					className={`ht-nudge ${nudge && asked ? "is-on" : ""}`}
				>
					<span className="ht-nudge-float">
						{/* Width reserved up front so each line types out from a fixed
						    left edge instead of walking as it grows. */}
						<span className={`ht-nudge-chip ${typed > 0 ? "is-typed" : ""}`}>
							<span className="invisible">{nudgeText}</span>
							<span className="absolute inset-0 flex items-center px-[10px]">
								{nudgeText.slice(0, typed)}
								{typed < nudgeText.length ? (
									<span className="ht-caret" />
								) : null}
							</span>
						</span>
						<Arrow className="ht-nudge-arrow" />
					</span>
				</span>
			</div>

			<h1 className={`${H_HERO} text-[clamp(36px,5.6vw,74px)]`}>
				<span className="sr-only">
					Record. Edit. Share. Cap has three recording modes: Instant, Studio,
					and Screenshot.
				</span>
				<span
					aria-hidden="true"
					className="ht-headline flex flex-col items-center sm:flex-row sm:justify-center sm:gap-[0.26em]"
				>
					{slide.words.map((word, i) => (
						<Slot
							key={`slot-${i === 0 ? "capture" : i === 1 ? "beat" : "payoff"}`}
							text={word}
							color={i === 2 ? accent : INK}
							strike={accent}
							delay={SLOT_DELAY[i] ?? 0}
							animate={!reduced}
						/>
					))}
				</span>
			</h1>
		</div>
	);
};

const CSS = `
/* The site's base sheet pins spans to line-height 1.5rem, which would
   collapse the slot line boxes. Restore the H_HERO leading. */
.ht-headline, .ht-headline span { line-height: 0.98; }

.ht-slot {
	position: relative;
	display: inline-block;
	white-space: nowrap;
	vertical-align: top;
	transition: width 560ms cubic-bezier(0.22, 0.9, 0.24, 1),
		color 1ms linear;
}
.ht-slot-ghost { visibility: hidden; }
.ht-layer {
	position: absolute;
	inset: 0;
	display: flex;
	align-items: flex-start;
	justify-content: center;
	white-space: nowrap;
	pointer-events: none;
}
.ht-layer > span { position: relative; display: inline-block; }

/* The cross-out rule, drawn through the x-height and running a hair past
   the word at both ends the way a pen would. */
.ht-strike {
	position: absolute;
	left: -0.04em;
	right: -0.04em;
	top: 0.54em;
	height: 0.055em;
	border-radius: 999px;
	transform-origin: left center;
	animation: ht-strike ${STRIKE_MS}ms cubic-bezier(0.5, 0, 0.2, 1) both;
}

@keyframes ht-strike { from { transform: scaleX(0); } to { transform: scaleX(1); } }
@keyframes ht-out {
	from { opacity: 1; transform: translate3d(0, 0, 0); }
	to { opacity: 0; transform: translate3d(0, -0.55em, 0); }
}
@keyframes ht-in {
	from { opacity: 0; transform: translate3d(0, 0.5em, 0); }
	to { opacity: 1; transform: translate3d(0, 0, 0); }
}
.ht-out { animation: ht-out ${LIFT_MS}ms cubic-bezier(0.4, 0, 0.75, 0.2) both; }
.ht-in { animation: ht-in ${RISE_MS}ms cubic-bezier(0.18, 0.9, 0.22, 1) both; }

/* Caret for the nudge as it types itself out. */
.ht-caret {
	display: inline-block;
	width: 1.5px;
	height: 1em;
	margin-left: 2px;
	vertical-align: -0.12em;
	background: rgba(255, 255, 255, 0.85);
	animation: ht-blink 1s steps(1, end) infinite;
}
@keyframes ht-blink { 0%, 50% { opacity: 1; } 50.01%, 100% { opacity: 0; } }

/* The cursor leaning in beside the mode bar. Hidden on phones, where there
   is no room beside a wrapped bar and no cursor to speak of on touch. */
.ht-nudge {
	display: block;
	position: absolute;
	left: 6%;
	right: auto;
	top: 46px;
	z-index: 20;
	pointer-events: none;
	opacity: 0;
	transform: translate3d(9px, 7px, 0) scale(0.94);
	transform-origin: right center;
	transition: opacity 260ms ease,
		transform 340ms cubic-bezier(0.18, 0.9, 0.22, 1);
}
.ht-nudge.is-on {
	opacity: 1;
	transform: translate3d(0, 0, 0) scale(1);
}
/* Bubble and cursor sit side by side, the tail on the bubble's right edge
   reaching across the gap to the arrow. */
.ht-nudge-float {
	display: flex;
	align-items: flex-start;
	gap: 7px;
}
.ht-nudge.is-on .ht-nudge-float {
	animation: ht-nudge-float 3.2s ease-in-out 360ms infinite;
}
@keyframes ht-nudge-float {
	0%, 100% { transform: translate3d(0, 0, 0); }
	50% { transform: translate3d(-3px, -3px, 0); }
}

.ht-nudge-arrow {
	display: none;
	flex: none;
	width: 17px;
	height: auto;
	filter: drop-shadow(0 2px 5px rgba(17, 17, 17, 0.28));
}
/* An iMessage bubble sitting to the left of the cursor with its tail aimed
   back at it. The mode bar and the page behind it are all white, so the chip
   needs its own colour to land, and it stays a size under the mode toggles
   (13px) so it reads as an aside rather than a fourth control. */
.ht-nudge-chip {
	position: relative;
	display: block;
	margin-top: 0;
	white-space: nowrap;
	border-radius: 13px;
	background: linear-gradient(180deg, #2f95ff 0%, #0a7cff 100%);
	padding: 5px 10px;
	font-size: 10.5px;
	font-weight: 500;
	letter-spacing: -0.005em;
	line-height: 1;
	color: #ffffff;
	box-shadow: 0 1px 1px rgba(10, 124, 255, 0.25),
		0 8px 18px -9px rgba(10, 124, 255, 0.55);
	opacity: 0;
	transition: opacity 170ms ease;
}
.ht-nudge-chip::before {
	content: "";
	position: absolute;
	left: 16px;
	top: -3px;
	width: 8px;
	height: 8px;
	border-radius: 2px;
	background: linear-gradient(180deg, #2f95ff 0%, #0a7cff 100%);
	transform: rotate(45deg);
}
/* Only ever seen with type in it, so the swap between the two lines resizes
   the chip while it is invisible. */
.ht-nudge-chip.is-typed { opacity: 1; }
@media (min-width: 768px) {
	.ht-nudge { left: auto; right: 80%; top: 26px; }
	.ht-nudge-arrow { display: block; }
	.ht-nudge-chip { margin-top: 14px; }
	.ht-nudge-chip::before { left: auto; right: -3px; top: 9px; }
}
@media (min-width: 1024px) { .ht-nudge { right: 94%; } }

@media (prefers-reduced-motion: reduce) {
	.ht-slot { transition: none; }
	.ht-nudge, .ht-nudge-chip { transition: none; }
	.ht-strike, .ht-out, .ht-in, .ht-caret { animation: none; }
	.ht-nudge.is-on .ht-nudge-float { animation: none; }
}
`;
