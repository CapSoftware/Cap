import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import {
	createEffect,
	createMemo,
	createSignal,
	on,
	onCleanup,
	Show,
} from "solid-js";
import toast from "solid-toast";
import { useEditorContext } from "./context";
import { getFpsStats } from "~/utils/socket";

type PerformanceOverlayProps = {
	size: { width: number; height: number };
};

type FrameStats = {
	fps: number;
	avgFrameMs: number;
	minFrameMs: number;
	maxFrameMs: number;
	jitter: number;
	droppedFrames: number;
	totalFrames: number;
};

type TransportStats = {
	renderFps: number;
	mbPerSec: number;
	sabResizes: number;
	sabFallbacks: number;
	sabOversizeFallbacks: number;
	sabRetryLimitFallbacks: number;
	sabRetriesInFlight: number;
	sabSlotSizeBytes: number;
	sabSlotCount: number;
	sabTotalBytes: number;
	workerFramesInFlight: number;
	workerInFlightBackpressureHits: number;
	workerInFlightBackpressureWindowHits: number;
	sabTotalRetryAttempts: number;
	sabTotalFramesReceived: number;
	sabTotalFramesWrittenToSharedBuffer: number;
	sabTotalFramesSentToWorker: number;
	sabTotalWorkerFallbackBytes: number;
	sabTotalSupersededDrops: number;
};

const STATS_WINDOW_MS = 1000;
const MAX_TIMESTAMPS = 120;

export function PerformanceOverlay(_props: PerformanceOverlayProps) {
	const { performanceMode, latestFrame, editorState } = useEditorContext();

	let frameTimestamps: number[] = [];
	let lastFrameTime = 0;
	let frameIntervals: number[] = [];
	let droppedFrameCount = 0;
	let totalFrameCount = 0;

	const [stats, setStats] = createSignal<FrameStats>({
		fps: 0,
		avgFrameMs: 0,
		minFrameMs: 0,
		maxFrameMs: 0,
		jitter: 0,
		droppedFrames: 0,
		totalFrames: 0,
	});
	const [transportStats, setTransportStats] = createSignal<TransportStats>({
		renderFps: 0,
		mbPerSec: 0,
		sabResizes: 0,
		sabFallbacks: 0,
		sabOversizeFallbacks: 0,
		sabRetryLimitFallbacks: 0,
		sabRetriesInFlight: 0,
		sabSlotSizeBytes: 0,
		sabSlotCount: 0,
		sabTotalBytes: 0,
		workerFramesInFlight: 0,
		workerInFlightBackpressureHits: 0,
		workerInFlightBackpressureWindowHits: 0,
		sabTotalRetryAttempts: 0,
		sabTotalFramesReceived: 0,
		sabTotalFramesWrittenToSharedBuffer: 0,
		sabTotalFramesSentToWorker: 0,
		sabTotalWorkerFallbackBytes: 0,
		sabTotalSupersededDrops: 0,
	});

	const calculateStats = (): FrameStats => {
		const now = performance.now();

		while (
			frameTimestamps.length > 0 &&
			now - frameTimestamps[0] > STATS_WINDOW_MS
		) {
			frameTimestamps.shift();
		}

		while (frameIntervals.length > MAX_TIMESTAMPS) {
			frameIntervals.shift();
		}

		if (frameTimestamps.length < 2) {
			return {
				fps: 0,
				avgFrameMs: 0,
				minFrameMs: 0,
				maxFrameMs: 0,
				jitter: 0,
				droppedFrames: droppedFrameCount,
				totalFrames: totalFrameCount,
			};
		}

		const windowMs = now - frameTimestamps[0];
		const fps =
			windowMs > 0 ? ((frameTimestamps.length - 1) / windowMs) * 1000 : 0;

		let avgFrameMs = 0;
		let minFrameMs = Number.MAX_VALUE;
		let maxFrameMs = 0;

		if (frameIntervals.length > 0) {
			let sum = 0;
			for (const interval of frameIntervals) {
				sum += interval;
				minFrameMs = Math.min(minFrameMs, interval);
				maxFrameMs = Math.max(maxFrameMs, interval);
			}
			avgFrameMs = sum / frameIntervals.length;
		}

		let jitter = 0;
		if (frameIntervals.length > 1) {
			let varianceSum = 0;
			for (const interval of frameIntervals) {
				varianceSum += (interval - avgFrameMs) ** 2;
			}
			jitter = Math.sqrt(varianceSum / frameIntervals.length);
		}

		return {
			fps,
			avgFrameMs,
			minFrameMs: minFrameMs === Number.MAX_VALUE ? 0 : minFrameMs,
			maxFrameMs,
			jitter,
			droppedFrames: droppedFrameCount,
			totalFrames: totalFrameCount,
		};
	};

	createEffect(
		on(
			() => latestFrame(),
			() => {
				if (!performanceMode()) return;

				const now = performance.now();
				totalFrameCount++;

				if (lastFrameTime > 0) {
					const interval = now - lastFrameTime;
					frameIntervals.push(interval);
					frameTimestamps.push(now);

					const expectedInterval = 1000 / 60;
					if (interval > expectedInterval * 1.8) {
						const missedFrames = Math.floor(interval / expectedInterval) - 1;
						droppedFrameCount += missedFrames;
					}
				} else {
					frameTimestamps.push(now);
				}

				lastFrameTime = now;
				setStats(calculateStats());
			},
		),
	);

	const resetStats = () => {
		frameTimestamps = [];
		frameIntervals = [];
		lastFrameTime = 0;
		droppedFrameCount = 0;
		totalFrameCount = 0;
		setStats({
			fps: 0,
			avgFrameMs: 0,
			minFrameMs: 0,
			maxFrameMs: 0,
			jitter: 0,
			droppedFrames: 0,
			totalFrames: 0,
		});
	};

	const resetTransportStats = () => {
		setTransportStats({
			renderFps: 0,
			mbPerSec: 0,
			sabResizes: 0,
			sabFallbacks: 0,
			sabOversizeFallbacks: 0,
			sabRetryLimitFallbacks: 0,
			sabRetriesInFlight: 0,
			sabSlotSizeBytes: 0,
			sabSlotCount: 0,
			sabTotalBytes: 0,
			workerFramesInFlight: 0,
			workerInFlightBackpressureHits: 0,
			workerInFlightBackpressureWindowHits: 0,
			sabTotalRetryAttempts: 0,
			sabTotalFramesReceived: 0,
			sabTotalFramesWrittenToSharedBuffer: 0,
			sabTotalFramesSentToWorker: 0,
			sabTotalWorkerFallbackBytes: 0,
			sabTotalSupersededDrops: 0,
		});
	};

	createEffect(() => {
		if (!performanceMode()) {
			resetStats();
			resetTransportStats();
		}
	});

	createEffect(() => {
		if (!performanceMode()) {
			return;
		}
		const updateTransportStats = () => {
			const socketStats = getFpsStats();
			if (!socketStats) {
				return;
			}
			setTransportStats({
				renderFps: socketStats.renderFps,
				mbPerSec: socketStats.mbPerSec,
				sabResizes: socketStats.sabResizes,
				sabFallbacks: socketStats.sabFallbacks,
				sabOversizeFallbacks: socketStats.sabOversizeFallbacks,
				sabRetryLimitFallbacks: socketStats.sabRetryLimitFallbacks,
				sabRetriesInFlight: socketStats.sabRetriesInFlight,
				sabSlotSizeBytes: socketStats.sabSlotSizeBytes,
				sabSlotCount: socketStats.sabSlotCount,
				sabTotalBytes: socketStats.sabTotalBytes,
				workerFramesInFlight: socketStats.workerFramesInFlight,
				workerInFlightBackpressureHits:
					socketStats.workerInFlightBackpressureHits,
				workerInFlightBackpressureWindowHits:
					socketStats.workerInFlightBackpressureWindowHits,
				sabTotalRetryAttempts: socketStats.sabTotalRetryAttempts,
				sabTotalFramesReceived: socketStats.sabTotalFramesReceived,
				sabTotalFramesWrittenToSharedBuffer:
					socketStats.sabTotalFramesWrittenToSharedBuffer,
				sabTotalFramesSentToWorker: socketStats.sabTotalFramesSentToWorker,
				sabTotalWorkerFallbackBytes: socketStats.sabTotalWorkerFallbackBytes,
				sabTotalSupersededDrops: socketStats.sabTotalSupersededDrops,
			});
		};
		updateTransportStats();
		const interval = setInterval(updateTransportStats, 250);
		onCleanup(() => clearInterval(interval));
	});

	onCleanup(() => {
		resetStats();
		resetTransportStats();
	});

	const formatFps = (fps: number) => fps.toFixed(1);
	const formatMs = (ms: number) => ms.toFixed(2);
	const formatMb = (value: number) => value.toFixed(1);
	const formatSlotMb = (bytes: number) => (bytes / (1024 * 1024)).toFixed(1);
	const formatPct = (value: number) => value.toFixed(1);
	const totalTransportedFrames = () =>
		transportStats().sabTotalFramesWrittenToSharedBuffer +
		transportStats().sabTotalFramesSentToWorker;
	const sabFrameSharePct = () => {
		const total = totalTransportedFrames();
		return total > 0
			? (transportStats().sabTotalFramesWrittenToSharedBuffer / total) * 100
			: 0;
	};
	const workerFrameSharePct = () => {
		const total = totalTransportedFrames();
		return total > 0
			? (transportStats().sabTotalFramesSentToWorker / total) * 100
			: 0;
	};
	const supersededDropPct = () =>
		transportStats().sabTotalFramesReceived > 0
			? (transportStats().sabTotalSupersededDrops /
					transportStats().sabTotalFramesReceived) *
				100
			: 0;

	const copyStatsToClipboard = async () => {
		const s = stats();
		const t = transportStats();
		const totalTransported =
			t.sabTotalFramesWrittenToSharedBuffer + t.sabTotalFramesSentToWorker;
		const sabSharePct =
			totalTransported > 0
				? (t.sabTotalFramesWrittenToSharedBuffer / totalTransported) * 100
				: 0;
		const workerSharePct =
			totalTransported > 0
				? (t.sabTotalFramesSentToWorker / totalTransported) * 100
				: 0;
		const supersededPct =
			t.sabTotalFramesReceived > 0
				? (t.sabTotalSupersededDrops / t.sabTotalFramesReceived) * 100
				: 0;
		const statsText = [
			`FPS: ${formatFps(s.fps)}`,
			`Frame: ${formatMs(s.avgFrameMs)}ms avg`,
			`Range: ${formatMs(s.minFrameMs)} - ${formatMs(s.maxFrameMs)}ms`,
			`Jitter: ±${formatMs(s.jitter)}ms`,
			`Render FPS: ${formatFps(t.renderFps)}`,
			`Transport: ${formatMb(t.mbPerSec)} MB/s`,
			`SAB Slot: ${formatSlotMb(t.sabSlotSizeBytes)} MB`,
			`SAB Slot Count: ${t.sabSlotCount}`,
			`SAB Total: ${formatSlotMb(t.sabTotalBytes)} MB`,
			`Worker Frames In Flight: ${t.workerFramesInFlight}`,
			`Worker In-Flight Cap Hits: ${t.workerInFlightBackpressureHits}`,
			`Worker In-Flight Cap Hits (Window): ${t.workerInFlightBackpressureWindowHits}`,
			`SAB Retry Attempts: ${t.sabTotalRetryAttempts}`,
			`SAB Frames Received: ${t.sabTotalFramesReceived}`,
			`SAB Frames Written: ${t.sabTotalFramesWrittenToSharedBuffer}`,
			`SAB Frames Sent to Worker: ${t.sabTotalFramesSentToWorker}`,
			`SAB Fallback Transfer: ${formatSlotMb(t.sabTotalWorkerFallbackBytes)} MB`,
			`SAB Superseded Drops: ${t.sabTotalSupersededDrops}`,
			`SAB Frame Share: ${formatPct(sabSharePct)}%`,
			`Worker Frame Share: ${formatPct(workerSharePct)}%`,
			`Superseded Drop Share: ${formatPct(supersededPct)}%`,
			`SAB Resizes: ${t.sabResizes}`,
			`SAB Fallbacks: ${t.sabFallbacks}`,
			`SAB Oversize Fallbacks: ${t.sabOversizeFallbacks}`,
			`SAB Retry Limit Fallbacks: ${t.sabRetryLimitFallbacks}`,
			`SAB Retries In Flight: ${t.sabRetriesInFlight}`,
			s.droppedFrames > 0
				? `Dropped: ${s.droppedFrames}/${s.totalFrames}`
				: null,
			`Playing: ${editorState.playing ? "Yes" : "No"}`,
		]
			.filter(Boolean)
			.join("\n");

		await writeText(statsText);
		toast.success("Performance stats copied to clipboard");
	};

	const fpsColor = createMemo(() => {
		const fps = stats().fps;
		if (fps >= 55) return "#4ade80";
		if (fps >= 45) return "#a3e635";
		if (fps >= 30) return "#fbbf24";
		if (fps >= 15) return "#fb923c";
		return "#f87171";
	});

	const jitterColor = createMemo(() => {
		const jitter = stats().jitter;
		if (jitter < 2) return "#4ade80";
		if (jitter < 5) return "#a3e635";
		if (jitter < 10) return "#fbbf24";
		return "#f87171";
	});

	return (
		<Show when={performanceMode()}>
			<div
				class="absolute top-2 left-2 z-50 pointer-events-none select-none"
				style={{
					"font-family":
						"ui-monospace, 'SF Mono', Monaco, 'Cascadia Mono', 'Segoe UI Mono', 'Roboto Mono', Menlo, monospace",
					"font-size": "10px",
					"line-height": "1.4",
					"font-variant-numeric": "tabular-nums",
				}}
			>
				<div
					class="rounded-md px-2 py-1.5 shadow-lg backdrop-blur-sm pointer-events-auto cursor-pointer hover:brightness-110 transition-[filter]"
					style={{
						"background-color": "rgba(0, 0, 0, 0.8)",
						border: "1px solid rgba(255, 255, 255, 0.15)",
					}}
					onClick={copyStatsToClipboard}
					title="Click to copy stats"
				>
					<div class="flex flex-col gap-0.5">
						<div class="flex items-center gap-2">
							<span class="font-bold" style={{ color: fpsColor() }}>
								{formatFps(stats().fps)} FPS
							</span>
							<Show when={editorState.playing}>
								<span style={{ color: "#4ade80" }}>▶</span>
							</Show>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>Frame: </span>
							<span style={{ color: "#93c5fd" }}>
								{formatMs(stats().avgFrameMs)}ms
							</span>
							<span style={{ color: "rgba(255, 255, 255, 0.4)" }}> avg</span>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>Range: </span>
							<span style={{ color: "#86efac" }}>
								{formatMs(stats().minFrameMs)}
							</span>
							<span style={{ color: "rgba(255, 255, 255, 0.3)" }}> - </span>
							<span style={{ color: "#fca5a5" }}>
								{formatMs(stats().maxFrameMs)}ms
							</span>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>Jitter: </span>
							<span style={{ color: jitterColor() }}>
								±{formatMs(stats().jitter)}ms
							</span>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>Render: </span>
							<span style={{ color: "#93c5fd" }}>
								{formatFps(transportStats().renderFps)} fps
							</span>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>Transport: </span>
							<span style={{ color: "#86efac" }}>
								{formatMb(transportStats().mbPerSec)} MB/s
							</span>
						</div>
						<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
							<span>SAB: </span>
							<span style={{ color: "#c4b5fd" }}>
								{formatSlotMb(transportStats().sabSlotSizeBytes)}MB slot
							</span>
							<span style={{ color: "rgba(255, 255, 255, 0.4)" }}>
								{" "}
								/ {transportStats().sabSlotCount} slots /{" "}
								{formatSlotMb(transportStats().sabTotalBytes)}MB total /{" "}
								{transportStats().sabResizes} resizes
							</span>
						</div>
						<Show when={transportStats().sabTotalFramesReceived > 0}>
							<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
								<span>SAB totals: </span>
								<span style={{ color: "#93c5fd" }}>
									{transportStats().sabTotalFramesReceived} recv
								</span>
								<span style={{ color: "rgba(255, 255, 255, 0.4)" }}>
									{" "}
									/ {transportStats().sabTotalFramesWrittenToSharedBuffer} sab /{" "}
									{transportStats().sabTotalFramesSentToWorker} worker /{" "}
									{transportStats().sabTotalSupersededDrops} superseded /{" "}
									{transportStats().sabTotalRetryAttempts} retries /{" "}
									{formatSlotMb(transportStats().sabTotalWorkerFallbackBytes)}MB
									fallback
								</span>
							</div>
						</Show>
						<Show when={totalTransportedFrames() > 0}>
							<div style={{ color: "rgba(255, 255, 255, 0.7)" }}>
								<span>Transport split: </span>
								<span style={{ color: "#93c5fd" }}>
									{formatPct(sabFrameSharePct())}% SAB
								</span>
								<span style={{ color: "rgba(255, 255, 255, 0.4)" }}>
									{" "}
									/ {formatPct(workerFrameSharePct())}% worker /{" "}
									{formatPct(supersededDropPct())}% superseded
								</span>
							</div>
						</Show>
						<Show when={transportStats().sabFallbacks > 0}>
							<div style={{ color: "#fbbf24" }}>
								SAB fallback {transportStats().sabFallbacks} (oversize{" "}
								{transportStats().sabOversizeFallbacks}, retry-limit{" "}
								{transportStats().sabRetryLimitFallbacks})
							</div>
						</Show>
						<Show when={transportStats().sabRetriesInFlight > 0}>
							<div style={{ color: "#f59e0b" }}>
								SAB retries in flight: {transportStats().sabRetriesInFlight}
							</div>
						</Show>
						<Show when={transportStats().workerFramesInFlight > 0}>
							<div style={{ color: "#fbbf24" }}>
								Worker frames in flight: {transportStats().workerFramesInFlight}
							</div>
						</Show>
						<Show when={transportStats().workerInFlightBackpressureHits > 0}>
							<div style={{ color: "#f59e0b" }}>
								Worker in-flight cap hits:{" "}
								{transportStats().workerInFlightBackpressureHits}
							</div>
						</Show>
						<Show
							when={transportStats().workerInFlightBackpressureWindowHits > 0}
						>
							<div style={{ color: "#fbbf24" }}>
								Worker cap hits (window):{" "}
								{transportStats().workerInFlightBackpressureWindowHits}
							</div>
						</Show>
						<Show when={stats().droppedFrames > 0}>
							<div style={{ color: "#f87171" }}>
								Dropped: {stats().droppedFrames}/{stats().totalFrames}
							</div>
						</Show>
					</div>
				</div>
			</div>
		</Show>
	);
}
