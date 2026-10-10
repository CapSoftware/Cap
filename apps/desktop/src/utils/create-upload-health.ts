import {
	type Accessor,
	createEffect,
	createSignal,
	on,
	onCleanup,
} from "solid-js";
import {
	getUploadHealthStatus,
	refreshUploadHealthStatus,
	type UploadHealthStatus,
} from "./upload-health";

const STARTUP_DELAY_MS = 800;
const POST_RECORDING_DELAY_MS = 1_000;
const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export function createUploadHealth(options: {
	serverUrl: Accessor<string>;
	userId: Accessor<string | null | undefined>;
	isRecording: Accessor<boolean>;
}) {
	const [status, setStatus] = createSignal<UploadHealthStatus | null>(null);
	const [refreshing, setRefreshing] = createSignal(false);
	let generation = 0;
	let requestId = 0;
	let activeGeneration: number | undefined;
	let refreshQueued = false;
	let disposed = false;
	let delayedRefresh: ReturnType<typeof setTimeout> | undefined;
	let refreshInterval: ReturnType<typeof setInterval> | undefined;

	const clearScheduledRefreshes = () => {
		clearTimeout(delayedRefresh);
		clearInterval(refreshInterval);
	};

	const load = async (refresh: boolean, queueIfBusy = false) => {
		if (disposed) return;
		const currentGeneration = generation;
		const shouldRefresh =
			refresh && !!options.userId() && !options.isRecording();
		if (shouldRefresh && activeGeneration !== undefined) {
			refreshQueued ||= queueIfBusy || activeGeneration !== currentGeneration;
			return;
		}
		const currentRequest = ++requestId;
		if (shouldRefresh) {
			clearScheduledRefreshes();
			refreshInterval = setInterval(() => void load(true), REFRESH_INTERVAL_MS);
			activeGeneration = currentGeneration;
			setRefreshing(true);
		}
		try {
			const result = await (shouldRefresh
				? refreshUploadHealthStatus()
				: getUploadHealthStatus());
			if (
				!disposed &&
				generation === currentGeneration &&
				requestId === currentRequest
			) {
				setStatus(result);
			}
		} catch (error) {
			if (
				!disposed &&
				generation === currentGeneration &&
				requestId === currentRequest
			) {
				setStatus(null);
				console.error("Failed to load upload health:", error);
			}
		} finally {
			if (shouldRefresh) {
				activeGeneration = undefined;
				if (!disposed) setRefreshing(false);
				if (refreshQueued) {
					refreshQueued = false;
					if (!disposed && options.userId() && !options.isRecording()) {
						void load(true);
					}
				}
			}
		}
	};

	const scheduleRefresh = (delay: number, queueIfBusy = false) => {
		clearScheduledRefreshes();
		delayedRefresh = setTimeout(() => void load(true, queueIfBusy), delay);
	};

	createEffect(
		on([options.serverUrl, options.userId], () => {
			generation++;
			setStatus(null);
			setRefreshing(false);
			void load(false);
			scheduleRefresh(STARTUP_DELAY_MS);
		}),
	);

	createEffect(
		on(
			options.isRecording,
			(recording, previous) => {
				if (recording) {
					clearScheduledRefreshes();
					void load(false);
				} else if (previous) {
					scheduleRefresh(POST_RECORDING_DELAY_MS, true);
				}
			},
			{ defer: true },
		),
	);

	onCleanup(() => {
		disposed = true;
		clearScheduledRefreshes();
	});

	return { status, refreshing, refresh: () => load(true) };
}
