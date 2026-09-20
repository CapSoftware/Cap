import * as shell from "@tauri-apps/plugin-shell";
import { createSignal, onMount, Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import { createTauriEventListener } from "~/utils/createEventListener";
import { commands, events, type UploadHealthStatus } from "~/utils/tauri";
import IconLucideLoader2 from "~icons/lucide/loader-2";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideTriangleAlert from "~icons/lucide/triangle-alert";
import IconLucideWifi from "~icons/lucide/wifi";

const SUPPORT_URL = "https://cap.link/discord";

function formatMbps(mbps: number) {
	return `${mbps >= 10 ? Math.round(mbps) : mbps.toFixed(1)} Mbps`;
}

export function UploadHealthIndicator() {
	const [status, setStatus] = createSignal<UploadHealthStatus | null>(null);

	const retry = () => {
		void commands
			.refreshUploadHealth()
			.then(setStatus)
			.catch(() => {});
	};

	onMount(() => {
		const refresh = () => {
			void commands
				.getUploadHealthStatus()
				.then(setStatus)
				.catch(() => {});
		};
		refresh();
		const timer = setInterval(refresh, 60_000);
		return () => clearInterval(timer);
	});

	createTauriEventListener(events.uploadHealthChanged, setStatus);

	const label = () => {
		const current = status();
		if (!current) return null;
		switch (current.state) {
			case "checking":
				return { icon: "loading" as const, text: "Checking upload…" };
			case "healthy":
				return {
					icon: "ok" as const,
					text: current.uploadMbps ? formatMbps(current.uploadMbps) : "Online",
				};
			case "degraded":
				return {
					icon: "warn" as const,
					text: current.uploadMbps
						? `${formatMbps(current.uploadMbps)} — slow`
						: "Slow upload",
				};
			case "failed":
				return { icon: "error" as const, text: "Upload unavailable" };
			default:
				return null;
		}
	};

	const tooltip = () => {
		const current = status();
		if (!current) return "";
		switch (current.state) {
			case "checking":
				return "Measuring your upload speed";
			case "healthy":
				return "Upload connection is working";
			case "degraded":
				return "Upload speed is low. Instant recordings will use a lower resolution.";
			case "failed":
				return `${current.error ?? "Uploads cannot reach Cap's servers."} Click to contact support.`;
			default:
				return "";
		}
	};

	return (
		<Show when={label()}>
			{(item) => (
				<div class="absolute bottom-[10px] right-[13px] flex items-center gap-1">
					<Show when={status()?.state === "failed"}>
						<Tooltip content={<span>Check again</span>}>
							<button
								type="button"
								onClick={retry}
								aria-label="Retry upload health check"
								class="flex items-center rounded-full bg-gray-2/80 p-1 text-gray-11 backdrop-blur-xs hover:text-gray-12"
							>
								<IconLucideRefreshCw class="size-3" />
							</button>
						</Tooltip>
					</Show>
					<Tooltip content={<span>{tooltip()}</span>}>
						<button
							type="button"
							onClick={() => {
								if (status()?.state === "failed") void shell.open(SUPPORT_URL);
							}}
							class="flex items-center gap-1 rounded-full bg-gray-2/80 px-2 py-0.5 text-[10px] font-medium text-gray-11 backdrop-blur-xs"
							classList={{
								"cursor-pointer hover:text-red-11":
									status()?.state === "failed",
							}}
						>
							<Show when={item().icon === "loading"}>
								<IconLucideLoader2 class="size-3 animate-spin" />
							</Show>
							<Show when={item().icon === "ok"}>
								<IconLucideWifi class="size-3 text-green-9" />
							</Show>
							<Show when={item().icon === "warn"}>
								<IconLucideTriangleAlert class="size-3 text-yellow-11" />
							</Show>
							<Show when={item().icon === "error"}>
								<IconLucideTriangleAlert class="size-3 text-red-9" />
							</Show>
							{item().text}
						</button>
					</Tooltip>
				</div>
			)}
		</Show>
	);
}
