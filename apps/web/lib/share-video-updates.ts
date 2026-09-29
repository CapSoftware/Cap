const CHANNEL = "cap-share-video-updates";
// Focus and visibility changes can come in bursts; a published video changes
// rarely, so one look per window is plenty.
const CHECK_INTERVAL_MS = 30_000;

type UpdateChannel = Pick<
	BroadcastChannel,
	"postMessage" | "close" | "addEventListener" | "removeEventListener"
>;

function openChannel(): UpdateChannel | null {
	try {
		return typeof BroadcastChannel === "undefined"
			? null
			: new BroadcastChannel(CHANNEL);
	} catch {
		return null;
	}
}

/**
 * Tells this browser's share pages for `videoId` that a Save may have
 * replaced its video, so an open one checks without waiting for focus.
 */
export function announceShareVideoUpdate(
	videoId: string,
	open: () => UpdateChannel | null = openChannel,
) {
	const channel = open();
	if (!channel) return;
	try {
		channel.postMessage({ videoId });
	} finally {
		channel.close();
	}
}

/**
 * Asks the server which version of the video it publishes when the page
 * comes back into view, gains focus, or hears a Save from another tab, and
 * calls `onNewer` when that isn't `revision`. Nothing runs on a timer, so a
 * page left open costs nothing until someone looks at it.
 */
export function watchShareVideoUpdates(options: {
	videoId: string;
	revision: string;
	onNewer: (revision: string) => void;
	fetchImpl?: typeof fetch;
	now?: () => number;
	open?: () => UpdateChannel | null;
}): () => void {
	const {
		videoId,
		revision,
		onNewer,
		fetchImpl = fetch,
		now = Date.now,
		open = openChannel,
	} = options;
	const controller = new AbortController();
	let checkedAt = now();
	let checking = false;
	// An announcement during a check may be for a Save that check started too
	// early to see.
	let recheck = false;

	const check = async (announced: boolean): Promise<void> => {
		if (checking) {
			recheck ||= announced;
			return;
		}
		if (!announced && now() - checkedAt < CHECK_INTERVAL_MS) return;
		checking = true;
		checkedAt = now();
		try {
			const response = await fetchImpl(
				`/api/videos/${encodeURIComponent(videoId)}/render-status`,
				{ cache: "no-store", signal: controller.signal },
			);
			if (!response.ok) return;
			const status: unknown = await response.json();
			const next =
				typeof status === "object" &&
				status !== null &&
				"revision" in status &&
				typeof status.revision === "string"
					? status.revision
					: null;
			if (next && next !== revision && !controller.signal.aborted)
				onNewer(next);
		} catch {
		} finally {
			checking = false;
		}
		if (recheck && !controller.signal.aborted) {
			recheck = false;
			await check(true);
		}
	};

	const onVisibility = () => {
		if (document.visibilityState === "visible") void check(false);
	};
	const onFocus = () => void check(false);
	const onMessage = (event: MessageEvent) => {
		const data: unknown = event.data;
		if (
			typeof data === "object" &&
			data !== null &&
			"videoId" in data &&
			data.videoId === videoId
		)
			void check(true);
	};
	document.addEventListener("visibilitychange", onVisibility);
	window.addEventListener("focus", onFocus);
	const channel = open();
	channel?.addEventListener("message", onMessage);

	return () => {
		controller.abort();
		document.removeEventListener("visibilitychange", onVisibility);
		window.removeEventListener("focus", onFocus);
		channel?.removeEventListener("message", onMessage);
		channel?.close();
	};
}
