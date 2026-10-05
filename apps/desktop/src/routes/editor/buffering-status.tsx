import { cx } from "cva";
import { createEffect, createSignal, onCleanup, Show, untrack } from "solid-js";

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

export function BufferingStatus(props: {
	playing: boolean;
	slow: boolean;
	class?: string;
}) {
	return (
		<div
			role="status"
			class={cx(
				"flex flex-col gap-0.5 justify-center px-2.5 py-1.5 min-h-7 max-w-64 text-[11px] font-medium rounded-lg pointer-events-none text-white/90 bg-black/45 backdrop-blur-md shadow-[0_0_0_0.5px_rgba(255,255,255,0.16),0_6px_16px_-4px_rgba(0,0,0,0.4)]",
				props.class,
			)}
		>
			<span class="flex gap-1.5 items-center">
				<span class="rounded-full border-2 size-3 shrink-0 border-white/30 border-t-white animate-spin motion-reduce:animate-none" />
				Loading video
			</span>
			<Show when={props.slow}>
				<span class="font-normal leading-snug text-white/70">
					{props.playing
						? "Your connection looks slow. Playback starts as soon as enough has loaded."
						: "Your connection looks slow. This frame shows as soon as it has loaded."}
				</span>
			</Show>
		</div>
	);
}
