import { useEffect, useState } from "react";

type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

/**
 * How long to wait before the next poll. A render normally reports within a
 * minute or two; one that runs on keeps being watched, but less often, and a
 * page left waiting on a render that never started stops asking.
 *
 * A page showing the render (`watching`) asks more often at first: a short
 * recording renders in a few seconds, and a 3 s poll added up to 3 s before
 * it played. It asks most often once the render is nearly done.
 */
export function renderStatusPollDelay(
	elapsedMs: number,
	rendering: boolean,
	watching?: { progress: number; playable: boolean },
): number | null {
	if (watching && elapsedMs < 60_000) {
		return rendering && (watching.playable || watching.progress >= 0.5)
			? 500
			: 1000;
	}
	if (elapsedMs < 2 * 60_000) return 3000;
	if (elapsedMs < 10 * 60_000) return 6000;
	if (elapsedMs < 60 * 60_000 || rendering) return 15_000;
	return null;
}

const MAX_UNANSWERED_POLLS = 20;

/**
 * While the status route keeps failing, check rarely instead of either
 * hammering it or giving up on a render that finishes once it recovers.
 */
export function unansweredPollDelay(elapsedMs: number): number | null {
	return elapsedMs < 4 * 60 * 60_000 ? 60_000 : null;
}

/**
 * Polls a render while it's running, and with `untilStarted`, while one that
 * is about to start hasn't reported yet. `watching` is for a page that shows
 * the render as it finishes (see renderStatusPollDelay).
 */
export function useRenderSaveStatus(
	videoId: string,
	enabled = true,
	untilStarted = false,
	watching = false,
) {
	const [status, setStatus] = useState<RenderSaveStatus | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const startedAt = Date.now();
		let rendering = false;
		let latest = { progress: 0, playable: false };
		let failures = 0;
		const poll = async () => {
			let answered = false;
			try {
				const response = await fetch(
					`/api/videos/${encodeURIComponent(videoId)}/render-status`,
					{ cache: "no-store", signal: controller.signal },
				);
				if (response.ok) {
					const next = (await response.json()) as RenderSaveStatus;
					answered = true;
					setStatus(next);
					rendering = next.state === "rendering";
					latest = next;
					if (!rendering && !untilStarted) return;
				}
			} catch {
				if (controller.signal.aborted) return;
			}
			failures = answered ? 0 : failures + 1;
			const elapsed = Date.now() - startedAt;
			const delay =
				failures >= MAX_UNANSWERED_POLLS
					? unansweredPollDelay(elapsed)
					: renderStatusPollDelay(
							elapsed,
							rendering,
							watching ? latest : undefined,
						);
			if (delay !== null) timer = setTimeout(poll, delay);
		};
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [videoId, enabled, untilStarted, watching]);
	return status;
}

/** How far a render has got, worded the same on the share page and dashboard. */
export function renderProgressLabel(progress: number) {
	const percent = Math.floor(progress * 100);
	return percent > 0 ? `Rendering · ${percent}%` : "Getting the video ready";
}
