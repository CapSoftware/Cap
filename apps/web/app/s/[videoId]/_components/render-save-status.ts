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
 */
export function renderStatusPollDelay(
	elapsedMs: number,
	rendering: boolean,
): number | null {
	if (elapsedMs < 2 * 60_000) return 3000;
	if (elapsedMs < 10 * 60_000) return 6000;
	if (elapsedMs < 60 * 60_000 || rendering) return 15_000;
	return null;
}

const MAX_UNANSWERED_POLLS = 20;

/**
 * Polls a render while it's running, and with `untilStarted`, while one that
 * is about to start hasn't reported yet.
 */
export function useRenderSaveStatus(
	videoId: string,
	enabled = true,
	untilStarted = false,
) {
	const [status, setStatus] = useState<RenderSaveStatus | null>(null);
	useEffect(() => {
		if (!enabled) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const controller = new AbortController();
		const startedAt = Date.now();
		let rendering = false;
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
					if (!rendering && !untilStarted) return;
				}
			} catch {
				if (controller.signal.aborted) return;
			}
			failures = answered ? 0 : failures + 1;
			// A render last seen running stays watched only while the status
			// route answers; one that has gone unreachable falls under the cutoff.
			if (failures >= MAX_UNANSWERED_POLLS) rendering = false;
			const delay = renderStatusPollDelay(Date.now() - startedAt, rendering);
			if (delay !== null) timer = setTimeout(poll, delay);
		};
		void poll();
		return () => {
			controller.abort();
			clearTimeout(timer);
		};
	}, [videoId, enabled, untilStarted]);
	return status;
}

/** How far a render has got, worded the same on the share page and dashboard. */
export function renderProgressLabel(progress: number) {
	const percent = Math.floor(progress * 100);
	return percent > 0 ? `Rendering · ${percent}%` : "Getting the video ready";
}
