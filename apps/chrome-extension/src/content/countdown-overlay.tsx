import { type CSSProperties, useCallback, useEffect, useState } from "react";
import { isOverlayMessage } from "../shared/messages";
import { sendServiceWorkerMessage } from "../shared/runtime";

type ActiveCountdown = {
	seconds: number;
	durationMs: number;
};

// The offscreen recorder waits the full countdown duration before capturing,
// but the relay to this tab adds latency, so the overlay must clear with margin
// to spare. Tab/screen capture would otherwise catch the tail of the count in
// the first recorded frames.
const FADE_MS = 220;
// Unmount this far before the recorder's own timer elapses.
const REMOVE_LEAD_MS = 140;

const classNames = (...values: Array<string | false | null | undefined>) =>
	values.filter(Boolean).join(" ");

// Full-screen pre-roll countdown (3, 2, 1) shown over the page right before a
// recording starts. The offscreen recorder owns the timing and waits the same
// duration, so this component is purely visual; pressing Escape cancels the
// pending start.
export function CountdownOverlay() {
	const [countdown, setCountdown] = useState<ActiveCountdown | null>(null);
	const [value, setValue] = useState(0);
	const [leaving, setLeaving] = useState(false);

	const dismiss = useCallback(() => {
		setCountdown(null);
		setLeaving(false);
	}, []);

	const cancel = useCallback(() => {
		dismiss();
		// Aborts the start while it is still in the countdown window; the
		// offscreen recorder tears down the half-built session without uploading.
		void sendServiceWorkerMessage({
			target: "service-worker",
			type: "stop-recording",
		}).catch(() => undefined);
	}, [dismiss]);

	useEffect(() => {
		const handleMessage = (
			message: unknown,
			_sender: chrome.runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
		) => {
			if (!isOverlayMessage(message)) return false;
			if (message.type === "overlay-countdown") {
				sendResponse({ ok: true });
				setLeaving(false);
				setValue(message.seconds);
				setCountdown({
					seconds: message.seconds,
					durationMs: message.durationMs,
				});
				return false;
			}
			// A stop or teardown elsewhere (panel stop button, capture ended)
			// clears the countdown without routing another stop request.
			if (message.type === "overlay-hide") {
				dismiss();
				return false;
			}
			return false;
		};

		chrome.runtime.onMessage.addListener(handleMessage);
		return () => chrome.runtime.onMessage.removeListener(handleMessage);
	}, [dismiss]);

	useEffect(() => {
		if (!countdown) return;
		const perNumberMs = countdown.durationMs / countdown.seconds;
		let current = countdown.seconds;
		setValue(current);

		const interval = window.setInterval(() => {
			current -= 1;
			if (current <= 0) {
				window.clearInterval(interval);
				return;
			}
			setValue(current);
		}, perNumberMs);
		const removeAt = Math.max(0, countdown.durationMs - REMOVE_LEAD_MS);
		const hideTimer = window.setTimeout(
			() => setLeaving(true),
			Math.max(0, removeAt - FADE_MS),
		);
		const removeTimer = window.setTimeout(() => {
			setCountdown(null);
			setLeaving(false);
		}, removeAt);

		return () => {
			window.clearInterval(interval);
			window.clearTimeout(hideTimer);
			window.clearTimeout(removeTimer);
		};
	}, [countdown]);

	useEffect(() => {
		if (!countdown) return;
		const handleKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			cancel();
		};
		window.addEventListener("keydown", handleKey, true);
		return () => window.removeEventListener("keydown", handleKey, true);
	}, [countdown, cancel]);

	if (!countdown) return null;

	const perNumberMs = countdown.durationMs / countdown.seconds;

	return (
		<div
			className={classNames("cap-extension-countdown", leaving && "is-leaving")}
			style={{ "--cap-countdown-step": `${perNumberMs}ms` } as CSSProperties}
			// Swallow pointer activity so clicks meant for the page do not land
			// while the screen is taken over by the countdown.
			onPointerDown={(event) => event.stopPropagation()}
		>
			<output className="cap-extension-countdown-sr">
				{`Recording starts in ${value}`}
			</output>
			<div className="cap-extension-countdown-stage">
				<svg
					className="cap-extension-countdown-ring"
					viewBox="0 0 120 120"
					aria-hidden="true"
				>
					<circle
						className="cap-extension-countdown-ring-track"
						cx="60"
						cy="60"
						r="54"
					/>
					<circle
						key={value}
						className="cap-extension-countdown-ring-progress"
						cx="60"
						cy="60"
						r="54"
					/>
				</svg>
				<span key={value} className="cap-extension-countdown-number">
					{value}
				</span>
			</div>
			<span className="cap-extension-countdown-hint">Press Esc to cancel</span>
		</div>
	);
}
