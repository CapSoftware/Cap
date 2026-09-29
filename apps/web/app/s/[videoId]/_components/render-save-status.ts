import { useEffect, useState } from "react";

type RenderSaveStatus = {
	state: "idle" | "rendering" | "ready" | "error";
	progress: number;
	playable: boolean;
	hlsUrl: string | null;
	error: string | null;
};

const POLL_MS = 3000;

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
		const poll = async () => {
			try {
				const response = await fetch(
					`/api/videos/${encodeURIComponent(videoId)}/render-status`,
					{ cache: "no-store", signal: controller.signal },
				);
				if (response.ok) {
					const next = (await response.json()) as RenderSaveStatus;
					setStatus(next);
					if (next.state !== "rendering" && !untilStarted) return;
				}
			} catch {
				if (controller.signal.aborted) return;
			}
			timer = setTimeout(poll, POLL_MS);
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
