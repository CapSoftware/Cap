import { useEffect, useState } from "react";

type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

// A page showing the render polls faster at first: a short recording renders
// in a few seconds, and a 3 s poll added up to 3 s before it played.
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

export function unansweredPollDelay(elapsedMs: number): number | null {
	return elapsedMs < 4 * 60 * 60_000 ? 60_000 : null;
}

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

export function renderProgressLabel(progress: number) {
	const percent = Math.floor(progress * 100);
	return percent > 0 ? `Rendering · ${percent}%` : "Getting the video ready";
}
