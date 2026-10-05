import { cx } from "cva";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";
import {
	type ConnectionLevel,
	createConnectionLevel,
} from "./connection-status";

/// A wait shorter than this passes without an indicator.
const SHOW_AFTER_MS = 250;
/// Past this, the indicator says why it is taking a while.
const SLOW_AFTER_MS = 2000;
/// A paused frame's indicator stays up at least this long, so a slow scrub
/// doesn't flicker it between frames. Playing frames end it at once.
const PAUSED_MIN_SHOWN_MS = 400;

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

/// Never takes a pointer, so editing carries on underneath.
export function BufferingStatus(props: {
	playing: boolean;
	slow: boolean;
	title?: string;
	then?: string;
	scrim?: boolean;
	class?: string;
}) {
	const connection = createConnectionLevel();
	const then = () =>
		props.then ??
		(props.playing
			? "Playback starts as soon as enough has loaded."
			: "This frame shows as soon as it has loaded.");
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
				class="flex relative flex-col items-center gap-2 px-4 pt-3.5 pb-3 max-w-[16.5rem] text-center rounded-xl text-white bg-[rgba(22,22,24,0.86)] shadow-[0_0_0_0.5px_rgba(255,255,255,0.14),0_10px_28px_-8px_rgba(0,0,0,0.5)]"
			>
				<span
					aria-hidden="true"
					class="rounded-full border-[2.5px] size-6 shrink-0 border-white/20 border-t-white animate-spin will-change-transform motion-reduce:animate-none"
				/>
				<span class="text-[13px] font-medium leading-4">
					{props.title ?? "Loading video"}
				</span>
				<Show when={props.slow}>
					<span class="-mt-0.5 text-[12px] leading-[16px] text-white/70">
						{slowLoadingMessage(connection(), then())}
					</span>
				</Show>
			</div>
		</div>
	);
}
