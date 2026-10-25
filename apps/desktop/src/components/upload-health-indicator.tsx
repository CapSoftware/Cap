import { createSignal, onCleanup, onMount, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import {
	commands,
	events,
	type UploadHealthState,
	type UploadHealthStatus,
} from "~/utils/tauri";

const REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export function formatUploadMbps(mbps: number): string {
	if (!Number.isFinite(mbps) || mbps < 0) {
		return "0.0 Mbps";
	}
	return `${mbps.toFixed(1)} Mbps`;
}

export function describeUploadHealthBadge(status: UploadHealthStatus): {
	label: string;
	tone: "healthy" | "degraded" | "error" | "neutral";
} {
	const speed =
		status.uploadMbps != null ? formatUploadMbps(status.uploadMbps) : null;

	switch (status.state) {
		case "healthy":
			return {
				label: speed
					? `${speed} · ${status.qualityLabel}`
					: `Upload ready · ${status.qualityLabel}`,
				tone: "healthy",
			};
		case "degraded":
			return {
				label: speed
					? `${speed} · ${status.qualityLabel}`
					: `Slow upload · ${status.qualityLabel}`,
				tone: "degraded",
			};
		case "unavailable":
			return {
				label: "Upload issue · Contact support",
				tone: "error",
			};
		case "unauthenticated":
			return {
				label: "Sign in for instant upload check",
				tone: "neutral",
			};
		case "checking":
		default:
			return {
				label: "Checking upload speed...",
				tone: "neutral",
			};
	}
}

export function UploadHealthIndicator(props: { isRecording: () => boolean }) {
	const [status, setStatus] = createSignal<UploadHealthStatus | null>(null);
	const [isRefreshing, setIsRefreshing] = createSignal(false);

	const loadUploadHealth = async (refresh: boolean) => {
		const shouldRefresh = refresh && !props.isRecording();
		setIsRefreshing(shouldRefresh);
		try {
			const nextStatus = shouldRefresh
				? await commands.refreshUploadHealthStatus()
				: await commands.getUploadHealthStatus();
			setStatus(nextStatus);
		} catch (error) {
			console.error("Failed to load upload health:", error);
		} finally {
			setIsRefreshing(false);
		}
	};

	onMount(() => {
		void loadUploadHealth(false);

		const intervalId = window.setInterval(() => {
			if (!props.isRecording()) {
				void loadUploadHealth(true);
			}
		}, REFRESH_INTERVAL_MS);

		let recordingStoppedTimeout: number | undefined;

		const unlistenUpdatedPromise = events.uploadHealthUpdated.listen(
			(event) => {
				setStatus(event.payload.status);
			},
		);

		const unlistenStoppedPromise = events.recordingStopped.listen(() => {
			if (recordingStoppedTimeout !== undefined) {
				window.clearTimeout(recordingStoppedTimeout);
			}
			recordingStoppedTimeout = window.setTimeout(() => {
				void loadUploadHealth(true);
			}, 1_000);
		});

		onCleanup(() => {
			window.clearInterval(intervalId);
			if (recordingStoppedTimeout !== undefined) {
				window.clearTimeout(recordingStoppedTimeout);
			}
			void unlistenUpdatedPromise.then((unlisten) => unlisten());
			void unlistenStoppedPromise.then((unlisten) => unlisten());
		});
	});

	const currentBadge = () => {
		const s = status();
		if (!s) return null;
		return { status: s, ...describeUploadHealthBadge(s) };
	};

	const dotColorClass = (state: UploadHealthState) => {
		switch (state) {
			case "healthy":
				return "bg-green-9";
			case "degraded":
				return "bg-amber-9";
			case "unavailable":
				return "bg-red-9";
			default:
				return "bg-gray-8";
		}
	};

	return (
		<Show when={!props.isRecording() && currentBadge()}>
			{(badge) => (
				<div class="mt-auto flex items-center justify-between gap-2 pt-1 text-[11px] text-gray-11">
					<Tooltip content={<span>{badge().status.message}</span>}>
						<button
							type="button"
							disabled={isRefreshing() || props.isRecording()}
							onClick={() => void loadUploadHealth(true)}
							class="inline-flex items-center gap-1.5 rounded-md border border-gray-4 bg-gray-2 px-2 py-0.5 text-[11px] text-gray-11 transition-colors hover:border-gray-5 hover:text-gray-12 disabled:opacity-60"
						>
							<span
								class={`size-1.5 rounded-full ${dotColorClass(badge().status.state)} ${
									isRefreshing() ? "animate-pulse" : ""
								}`}
							/>
							<span class="truncate">{badge().label}</span>
						</button>
					</Tooltip>
					<Show when={badge().status.state === "unavailable"}>
						<button
							type="button"
							onClick={() =>
								void commands.openExternalLink(badge().status.supportUrl)
							}
							class="text-[11px] font-medium text-red-11 underline hover:text-red-12"
						>
							Contact support
						</button>
					</Show>
				</div>
			)}
		</Show>
	);
}
