import { createMutation } from "@tanstack/solid-query";
import { cx } from "cva";
import {
	createEffect,
	createSignal,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import Tooltip from "~/components/Tooltip";
import {
	commands,
	events,
	type HealthCheckResult,
	type SpeedTestStatus,
} from "~/utils/tauri";
import IconLucideActivity from "~icons/lucide/activity";
import IconLucideGauge from "~icons/lucide/gauge";
import IconLucideCheck from "~icons/lucide/check";
import IconLucideAlertTriangle from "~icons/lucide/alert-triangle";
import IconLucideLoader from "~icons/lucide/loader-2";

export default function NetworkStatus() {
	const [speedStatus, setSpeedStatus] = createSignal<SpeedTestStatus>("idle");
	const [healthResult, setHealthResult] =
		createSignal<HealthCheckResult | null>(null);

	onMount(async () => {
		try {
			const [status, health] = await commands.getNetworkStatus();
			setSpeedStatus(status);
			setHealthResult(health ?? null);
		} catch (e) {
			console.error("Failed to get network status:", e);
		}
	});

	onMount(async () => {
		const unlistenSpeed = await events.speedTestUpdate.listen((event) => {
			setSpeedStatus(event.payload.status);
		});

		const unlistenHealth = await events.healthCheckUpdate.listen((event) => {
			setHealthResult(event.payload.result);
		});

		onCleanup(() => {
			unlistenSpeed();
			unlistenHealth();
		});
	});

	const speedTest = createMutation(() => ({
		mutationKey: ["speed-test"],
		mutationFn: async () => {
			return await commands.runSpeedTest();
		},
	}));

	const healthCheck = createMutation(() => ({
		mutationKey: ["health-check"],
		mutationFn: async () => {
			return await commands.runHealthCheck();
		},
	}));

	const speedLabel = () => {
		const status = speedStatus();
		if (status === "idle") return "Speed: --";
		if (status === "running") return "Testing...";
		if (typeof status === "object" && "completed" in status) {
			return `${status.completed.uploadSpeedMbps} Mbps`;
		}
		if (typeof status === "object" && "failed" in status) {
			return "Speed: Error";
		}
		return "Speed: --";
	};

	const speedQuality = () => {
		const status = speedStatus();
		if (typeof status === "object" && "completed" in status) {
			return status.completed.recommendedQuality;
		}
		return null;
	};

	const qualityColor = () => {
		const q = speedQuality();
		if (!q) return "text-gray-10";
		if (q === "full" || q === "high") return "text-green-10";
		if (q === "medium") return "text-yellow-10";
		return "text-red-10";
	};

	const healthOk = () => {
		const result = healthResult();
		if (!result) return null;
		return result.serverReachable && result.authValid && result.uploadFunctional;
	};

	const healthColor = () => {
		const ok = healthOk();
		if (ok === null) return "text-gray-10";
		if (ok) return "text-green-10";
		return "text-red-10";
	};

	const healthMessage = () => {
		const result = healthResult();
		if (!result) return "Health check not run yet";
		return result.message;
	};

	const isSpeedRunning = () => {
		const status = speedStatus();
		return status === "running";
	};

	return (
		<div class="flex items-center gap-2 px-3 py-1.5 text-[11px]">
			<Tooltip content={healthMessage()}>
				<button
					type="button"
					onClick={() => healthCheck.mutate()}
					disabled={healthCheck.isPending}
					class={cx(
						"flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-gray-4",
						healthColor(),
					)}
				>
					<Show
						when={!healthCheck.isPending}
						fallback={
							<IconLucideLoader class="size-3 animate-spin" />
						}
					>
						<Show
							when={healthOk() !== null}
							fallback={<IconLucideActivity class="size-3" />}
						>
							<Show
								when={healthOk()}
								fallback={
									<IconLucideAlertTriangle class="size-3" />
								}
							>
								<IconLucideCheck class="size-3" />
							</Show>
						</Show>
					</Show>
					<span>
						{healthOk() === null
							? "Health"
							: healthOk()
								? "OK"
								: "Issue"}
					</span>
				</button>
			</Tooltip>

			<div class="w-px h-3 bg-gray-6" />

			<Tooltip
				content={
					speedQuality()
						? `Recommended quality: ${speedQuality()}`
						: "Run a speed test to check upload bandwidth"
				}
			>
				<button
					type="button"
					onClick={() => speedTest.mutate()}
					disabled={isSpeedRunning() || speedTest.isPending}
					class={cx(
						"flex items-center gap-1 rounded px-1.5 py-0.5 transition-colors hover:bg-gray-4",
						qualityColor(),
					)}
				>
					<Show
						when={!isSpeedRunning()}
						fallback={
							<IconLucideLoader class="size-3 animate-spin" />
						}
					>
						<IconLucideGauge class="size-3" />
					</Show>
					<span>{speedLabel()}</span>
				</button>
			</Tooltip>
		</div>
	);
}
