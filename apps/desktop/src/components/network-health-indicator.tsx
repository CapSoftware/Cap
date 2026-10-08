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
	const isRecording = isRecordingInProgress;

	const handleRefresh = async (e: MouseEvent) => {
		e.stopPropagation();
		if (isRecording() || isChecking()) return;
		await runUploadHealthCheck();
		await runSpeedTest();
	};

	const speedLabel = () => {
		if (speedTest().status === "running") return "Testing...";
		if (speedTest().status === "error" && speedTest().speedMbps === null)
			return "Failed";
		if (speedTest().speedMbps !== null) return `${speedTest().speedMbps} Mbps`;
		if (networkHealth().status === "checking") return "Checking...";
		if (isUnhealthy()) return "Offline";
		return "Ready";
	};

	const qualityLabel = () => {
		const label = speedTest().recommendedLabel;
		return label ? `${label}` : "1080p";
	};

	const dotColor = () => {
		if (isUnhealthy()) return "bg-red-9";
		if (speedTest().status === "running") return "bg-blue-9 animate-pulse";
		if (speedTest().status === "error" && speedTest().speedMbps === null)
			return "bg-red-9";
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
						isUnhealthy() || speedTest().status === "error"
							? "text-red-10"
							: "text-green-10",
					)}
				>
					{isUnhealthy() ||
					(speedTest().status === "error" && speedTest().speedMbps === null)
						? "Error"
						: "Operational"}
				</span>
			</div>
			<div class="flex items-center justify-between text-gray-11">
				<span>Upload Speed:</span>
				<span class="font-medium text-gray-12">{speedLabel()}</span>
			</div>
			<div class="flex items-center justify-between text-gray-11">
				<span>Recommended Quality:</span>
				<span class="font-medium text-gray-12">{qualityLabel()}</span>
			</div>
			<Show when={networkHealth().error || speedTest().error}>
				<div class="mt-1 rounded bg-red-3 p-1.5 text-[11px] text-red-11 border border-red-6">
					{networkHealth().error ?? speedTest().error}
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
						isUnhealthy() ||
							(speedTest().status === "error" && speedTest().speedMbps === null)
							? "bg-red-3 text-red-11 border-red-6 hover:bg-red-4"
							: "bg-gray-2 text-gray-11 border-gray-6 hover:bg-gray-3 hover:text-gray-12",
					)}
				>
					<Show
						when={
							!isUnhealthy() &&
							!(
								speedTest().status === "error" && speedTest().speedMbps === null
							)
						}
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
export { NetworkHealthIndicator };
