import { cx } from "cva";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import {
	type ConnectionLevel,
	createConnectionLevel,
} from "./connection-status";
import { InkLoader } from "./ink-loader";

/// A wait shorter than this passes without an indicator.
const SHOW_AFTER_MS = 250;
/// Past this, the indicator says why it is taking a while.
const SLOW_AFTER_MS = 2000;
/// A paused frame's indicator stays up at least this long, so a slow scrub
/// doesn't flicker it between frames. Playing frames end it at once.
const PAUSED_MIN_SHOWN_MS = 400;
/// Frames at 30 fps move the playhead every 33 ms; this long without a move
/// means they have stopped.
const FLOWING_FOR_MS = 500;

export function createBufferingDisplay(
	waiting: () => boolean,
	playing: () => boolean,
) {
	const [shown, setShown] = createSignal(false);
	const [slow, setSlow] = createSignal(false);
	let shownAt = 0;
	createEffect(() => {
		if (waiting()) {
			const show = setTimeout(() => {
				shownAt = performance.now();
				setShown(true);
			}, SHOW_AFTER_MS);
			const explain = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
			onCleanup(() => {
				clearTimeout(show);
				clearTimeout(explain);
			});
			return;
		}
		const hide = () => {
			setShown(false);
			setSlow(false);
		};
		const hold =
			untrack(shown) && !untrack(playing)
				? PAUSED_MIN_SHOWN_MS - (performance.now() - shownAt)
				: 0;
		if (hold <= 0) {
			hide();
			return;
		}
		const timer = setTimeout(hide, hold);
		onCleanup(() => clearTimeout(timer));
	});
	return { shown, slow };
}

/// Whether playback frames are arriving: the playhead moved while playing
/// within the last moment. A wait is over once they are, whatever is still
/// reported, so the loading status clears with the first moving frame.
export function createFramesFlowing(
	playheadSeconds: () => number,
	playing: () => boolean,
) {
	const [flowing, setFlowing] = createSignal(false);
	let last: number | undefined;
	createEffect(() => {
		const time = playheadSeconds();
		const moved = last !== undefined && time !== last;
		last = time;
		if (!untrack(playing) || !moved) return;
		setFlowing(true);
		const timer = setTimeout(() => setFlowing(false), FLOWING_FOR_MS);
		onCleanup(() => clearTimeout(timer));
	});
	createEffect(() => {
		if (!playing()) setFlowing(false);
	});
	return flowing;
}

export function slowLoadingMessage(
	level: ConnectionLevel | null,
	then: string,
) {
	if (level === "offline")
		return "You're offline. Video that hasn't loaded yet needs a connection.";
	if (level === "poor") return `Your connection looks slow. ${then}`;
	if (level === "fair") return `Your connection is a little slow. ${then}`;
	return `Taking longer than usual. ${then}`;
}

function fadeIn(element: HTMLElement) {
	if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
	// Solid builds the element in its template's inert document, whose
	// animation timeline never runs, so it starts once the element is in the
	// page: still before the frame that first paints it.
	requestAnimationFrame(() => {
		if (element.isConnected) animateIn(element);
	});
}

function animateIn(element: HTMLElement) {
	element.animate(
		[
			{ opacity: 0, transform: "translateY(4px) scale(0.98)" },
			{ opacity: 1, transform: "none" },
		],
		{ duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
	);
}

/// Never takes a pointer, so editing carries on underneath. Over the frame
/// it draws in white on a soft shade rather than a card, so the picture
/// stays in view.
export function BufferingStatus(props: {
	playing: boolean;
	slow: boolean;
	onFrame?: boolean;
	scrim?: boolean;
	class?: string;
}) {
	const connection = createConnectionLevel();
	const then = () =>
		props.playing
			? "Playback starts as soon as enough has loaded."
			: "This frame shows as soon as it has loaded.";
	return (
		<div
			class={cx(
				"flex absolute inset-0 z-30 justify-center items-center p-3 pointer-events-none",
				props.class,
			)}
		>
			<Show when={props.scrim}>
				<div ref={fadeIn} class="absolute inset-0 bg-black/20" />
			</Show>
			<div
				ref={fadeIn}
				role="status"
				class={cx(
					"flex relative flex-col items-center gap-2.5 px-6 py-5 max-w-[18rem] text-center",
					props.onFrame &&
						"bg-[radial-gradient(closest-side,rgba(0,0,0,0.32),rgba(0,0,0,0.12)_60%,transparent)]",
				)}
			>
				<InkLoader size="lg" tone={props.onFrame ? "media" : "muted"} />
				<span class="sr-only">Loading video</span>
				<Show when={props.slow}>
					<span
						class={cx(
							"text-[12px] leading-[16px]",
							props.onFrame
								? "text-white/90 [text-shadow:0_1px_8px_rgba(0,0,0,0.6)]"
								: "text-ed-text-2",
						)}
					>
						{slowLoadingMessage(connection(), then())}
					</span>
				</Show>
			</div>
		</div>
	);
}
