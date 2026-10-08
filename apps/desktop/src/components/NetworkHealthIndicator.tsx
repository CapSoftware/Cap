import { cx } from "cva";
import { Show } from "solid-js";
import Tooltip from "~/components/Tooltip";
import {
	isRecordingInProgress,
	networkHealth,
	runSpeedTest,
	runUploadHealthCheck,
	speedTest,
} from "~/utils/network-health";
import IconLucideAlertTriangle from "~icons/lucide/alert-triangle";
import IconLucideRefreshCw from "~icons/lucide/refresh-cw";
import IconLucideWifi from "~icons/lucide/wifi";

interface NetworkHealthIndicatorProps {
	class?: string;
}

export default function NetworkHealthIndicator(
	props: NetworkHealthIndicatorProps,
) {
	const isUnhealthy = () => networkHealth().status === "unhealthy";
	const isChecking = () =>
		networkHealth().status === "checking" || speedTest().status === "running";
	const isRecording = () => isRecordingInProgress();

	const handleRefresh = async (e: MouseEvent) => {
		e.stopPropagation();
		if (isRecording() || isChecking()) return;
		await runUploadHealthCheck();
		await runSpeedTest();
	};

	const speedLabel = () => {
		const mbps = speedTest().speedMbps;
		if (mbps === null) return "Checking...";
		return `${mbps} Mbps`;
	};

	const qualityLabel = () => {
		const tier = speedTest().qualityTier;
		const res = speedTest().recommendedResolution;
		if (!tier) return "Standard (1080p)";
		if (tier === "high") return `Full (${res}p)`;
		if (tier === "medium") return `Standard (${res}p)`;
		return `Adapted (${res}p)`;
	};

	const dotColor = () => {
		if (isUnhealthy()) return "bg-red-9";
		if (speedTest().status === "running") return "bg-blue-9 animate-pulse";
		const speed = speedTest().speedMbps;
		if (speed === null) return "bg-gray-8";
		if (speed >= 15) return "bg-green-9";
		if (speed >= 5) return "bg-blue-9";
		return "bg-amber-9";
	};

	const tooltipContent = () => (
		<div class="flex flex-col gap-1 p-1 text-left text-xs min-w-44">
			<div class="flex items-center justify-between font-semibold">
				<span>Network Health</span>
				<span
					class={cx(
						"text-[10px] uppercase font-bold",
						isUnhealthy() ? "text-red-10" : "text-green-10",
					)}
				>
					{isUnhealthy() ? "Failed" : "Operational"}
				</span>
			</div>
			<div class="flex items-center justify-between text-gray-11">
				<span>Upload Speed:</span>
				<span class="font-medium text-gray-12">{speedLabel()}</span>
			</div>
			<div class="flex items-center justify-between text-gray-11">
				<span>Recording Quality:</span>
				<span class="font-medium text-gray-12">{qualityLabel()}</span>
			</div>
			<Show when={isUnhealthy()}>
				<div class="mt-1 rounded bg-red-3 p-1.5 text-[11px] text-red-11 border border-red-6">
					Upload test failed. Recording uploads might fail. Please contact
					support at hello@cap.so
				</div>
			</Show>
			<div class="mt-1 pt-1 border-t border-gray-6 flex justify-end">
				<button
					type="button"
					onClick={handleRefresh}
					disabled={isRecording() || isChecking()}
					class="flex items-center gap-1 text-[11px] text-gray-11 hover:text-gray-12 disabled:opacity-50"
				>
					<IconLucideRefreshCw
						class={cx("size-3", isChecking() && "animate-spin")}
					/>
					<span>Retest Speed</span>
				</button>
			</div>
		</div>
	);

	return (
		<div
			class={cx("inline-flex items-center gap-1.5 select-none", props.class)}
		>
			<Tooltip content={tooltipContent()}>
				<button
					type="button"
					onClick={handleRefresh}
					disabled={isRecording()}
					aria-label="Network health and speed indicator"
					class={cx(
						"flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] transition-colors border",
						isUnhealthy()
							? "bg-red-3 text-red-11 border-red-6 hover:bg-red-4"
							: "bg-gray-2 text-gray-11 border-gray-6 hover:bg-gray-3 hover:text-gray-12",
					)}
				>
					<Show
						when={!isUnhealthy()}
						fallback={<IconLucideAlertTriangle class="size-3 text-red-9" />}
					>
						<span class={cx("size-1.5 rounded-full shrink-0", dotColor())} />
						<IconLucideWifi class="size-3 shrink-0" />
					</Show>
					<span class="font-medium truncate max-w-20">
						{isUnhealthy() ? "Upload Error" : speedLabel()}
					</span>
				</button>
			</Tooltip>
		</div>
	);
}
