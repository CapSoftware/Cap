import { Button } from "@cap/ui-solid";
import { useSearchParams } from "@solidjs/router";
import { convertFileSrc } from "@tauri-apps/api/core";
import { cx } from "cva";
import {
	createEffect,
	createMemo,
	createSignal,
	For,
	onCleanup,
	onMount,
	Show,
} from "solid-js";
import {
	clearRecordingHealthTarget,
	consumeRecordingHealthTarget,
	inspectRecordingHealth,
	type RecordingHealthProgress,
	type RecordingHealthReport,
	type RecordingHealthStatus,
	repairRecordingHealth,
	scanRecordingHealth,
} from "~/utils/recordingHealth";
import { commands } from "~/utils/tauri";
import IconLucideChevronDown from "~icons/lucide/chevron-down";
import IconLucideChevronLeft from "~icons/lucide/chevron-left";

type Slot =
	| { kind: "pending"; key: string; name: string | null }
	| { kind: "report"; key: string; report: RecordingHealthReport };

const ROW_HEIGHT = "h-[60px]";

export default function RecordingHealthPage() {
	const [searchParams, setSearchParams] = useSearchParams();
	const initialQueryPath = () => {
		const value = searchParams.recording;
		return typeof value === "string" && value.length > 0 ? value : null;
	};
	const storedTarget = initialQueryPath()
		? null
		: consumeRecordingHealthTarget();
	const [selectedPath, setSelectedPath] = createSignal<string | null>(
		initialQueryPath() ?? storedTarget?.projectPath ?? null,
	);
	const [shouldAutoRepair, setShouldAutoRepair] = createSignal(
		initialQueryPath()
			? searchParams.repair === "1"
			: (storedTarget?.autoRepair ?? false),
	);

	const [slots, setSlots] = createSignal<Slot[]>([]);
	const [loading, setLoading] = createSignal(false);
	const [scanProgress, setScanProgress] = createSignal<{
		completed: number;
		total: number;
	} | null>(null);
	const [error, setError] = createSignal<string | null>(null);
	const [repairingPath, setRepairingPath] = createSignal<string | null>(null);
	const [bulkRepair, setBulkRepair] = createSignal<{
		completed: number;
		total: number;
	} | null>(null);
	const [autoRepairPath, setAutoRepairPath] = createSignal<string | null>(null);
	const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

	const applyStoredTarget = () => {
		const target = consumeRecordingHealthTarget();
		if (!target) return;
		setSelectedPath(target.projectPath);
		setShouldAutoRepair(target.autoRepair);
		setAutoRepairPath(null);
	};

	onMount(() => {
		if (typeof window === "undefined") return;
		window.addEventListener("focus", applyStoredTarget);
		onCleanup(() => window.removeEventListener("focus", applyStoredTarget));
	});

	createEffect(() => {
		const path = initialQueryPath();
		if (!path) return;
		setSelectedPath(path);
		setShouldAutoRepair(searchParams.repair === "1");
	});

	const reports = createMemo(() =>
		slots()
			.filter(
				(slot): slot is Extract<Slot, { kind: "report" }> =>
					slot.kind === "report",
			)
			.map((slot) => slot.report),
	);

	const summary = createMemo(() => {
		const all = reports();
		return {
			total: all.length,
			problematic: all.filter((r) => r.status !== "healthy").length,
			repairable: all.filter((r) => r.repairable).length,
		};
	});

	const handleProgress = (progress: RecordingHealthProgress) => {
		if (progress.total > 0) {
			setScanProgress({
				completed: progress.completed,
				total: progress.total,
			});
			setSlots((current) => {
				if (current.length === progress.total) return current;
				const next = current.slice(0, progress.total);
				while (next.length < progress.total) {
					next.push({
						kind: "pending",
						key: `pending:${next.length}`,
						name: null,
					});
				}
				return next;
			});
		}

		if (progress.currentName && !progress.report) {
			const idx = progress.completed;
			setSlots((current) => {
				if (idx >= current.length) return current;
				const slot = current[idx];
				if (!slot || slot.kind !== "pending") return current;
				const next = [...current];
				next[idx] = {
					kind: "pending",
					key: slot.key,
					name: progress.currentName,
				};
				return next;
			});
		}

		if (progress.report) {
			const report = progress.report;
			const targetIndex = Math.max(0, progress.completed - 1);
			setSlots((current) => {
				const next = [...current];
				if (targetIndex < next.length) {
					next[targetIndex] = {
						kind: "report",
						key: report.projectPath,
						report,
					};
				} else {
					next.push({
						kind: "report",
						key: report.projectPath,
						report,
					});
				}
				return next;
			});
		}
	};

	const loadReports = async () => {
		const path = selectedPath();
		setError(null);
		setLoading(true);
		setScanProgress(null);

		if (path) {
			setSlots([
				{
					kind: "pending",
					key: path,
					name: pathName(path),
				},
			]);
		}

		try {
			if (path) {
				const report = await inspectRecordingHealth(path);
				setSlots([
					{
						kind: "report",
						key: report.projectPath,
						report,
					},
				]);
				setExpanded(new Set([report.projectPath]));
			} else {
				const results = await scanRecordingHealth(handleProgress);
				setSlots(
					results.map((report) => ({
						kind: "report" as const,
						key: report.projectPath,
						report,
					})),
				);
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setSlots([]);
		} finally {
			setLoading(false);
			setScanProgress(null);
		}
	};

	createEffect(() => {
		selectedPath();
		void loadReports();
	});

	const replaceReport = (next: RecordingHealthReport) => {
		setSlots((current) =>
			current.map((slot) =>
				slot.kind === "report" && slot.report.projectPath === next.projectPath
					? { kind: "report", key: next.projectPath, report: next }
					: slot,
			),
		);
	};

	const repairOne = async (projectPath: string) => {
		setRepairingPath(projectPath);
		try {
			const next = await repairRecordingHealth(projectPath);
			replaceReport(next);
			setExpanded((current) => {
				const updated = new Set(current);
				updated.add(projectPath);
				return updated;
			});
		} finally {
			setRepairingPath(null);
		}
	};

	const repairAll = async () => {
		const repairable = reports().filter((r) => r.repairable);
		if (repairable.length === 0) return;
		setBulkRepair({ completed: 0, total: repairable.length });
		try {
			for (const [index, report] of repairable.entries()) {
				setBulkRepair({ completed: index, total: repairable.length });
				setRepairingPath(report.projectPath);
				const next = await repairRecordingHealth(report.projectPath);
				replaceReport(next);
			}
			setBulkRepair({
				completed: repairable.length,
				total: repairable.length,
			});
		} finally {
			setBulkRepair(null);
			setRepairingPath(null);
		}
	};

	createEffect(() => {
		const path = selectedPath();
		if (!path || !shouldAutoRepair() || autoRepairPath() === path || loading())
			return;
		setAutoRepairPath(path);
		void repairOne(path);
	});

	const clearSelectedRecording = () => {
		clearRecordingHealthTarget();
		setSelectedPath(null);
		setShouldAutoRepair(false);
		setAutoRepairPath(null);
		setSearchParams({ recording: undefined, repair: undefined });
	};

	const toggleExpanded = (key: string) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	const isBusy = createMemo(
		() => loading() || !!bulkRepair() || !!repairingPath(),
	);

	const statusLine = createMemo(() => {
		if (loading()) {
			const progress = scanProgress();
			if (progress)
				return `Scanning ${progress.completed} of ${progress.total}`;
			return selectedPath() ? "Checking recording" : "Looking for recordings";
		}
		const bulk = bulkRepair();
		if (bulk) return `Repairing ${bulk.completed + 1} of ${bulk.total}`;
		const stats = summary();
		if (stats.total === 0) return "No recordings found";
		if (stats.problematic === 0)
			return `${stats.total} recording${stats.total === 1 ? "" : "s"} · All healthy`;
		return `${stats.total} recording${stats.total === 1 ? "" : "s"} · ${stats.problematic} need${stats.problematic === 1 ? "s" : ""} attention`;
	});

	const progressPercent = createMemo(() => {
		if (loading()) {
			const progress = scanProgress();
			if (!progress || progress.total === 0) return 6;
			return Math.max(4, (progress.completed / progress.total) * 100);
		}
		const bulk = bulkRepair();
		if (bulk && bulk.total > 0)
			return Math.max(4, (bulk.completed / bulk.total) * 100);
		return 0;
	});

	const headerRepair = () => {
		const path = selectedPath();
		if (!path) return null;
		const report = reports().find((r) => r.projectPath === path);
		return report ?? null;
	};

	return (
		<div class="flex h-full w-full flex-col overflow-hidden bg-gray-1 text-gray-12">
			<div class="flex flex-col gap-3 border-b border-gray-3 px-4 pt-4 pb-3">
				<div class="flex items-center justify-between gap-3">
					<div class="flex min-w-0 items-center gap-2">
						<Show when={selectedPath()}>
							<button
								type="button"
								onClick={clearSelectedRecording}
								class="flex size-6 items-center justify-center rounded-md text-gray-11 transition-colors hover:bg-gray-3 hover:text-gray-12"
								aria-label="Back to all recordings"
							>
								<IconLucideChevronLeft class="size-4" />
							</button>
						</Show>
						<h2 class="text-base font-medium text-gray-12">Health Check</h2>
					</div>
					<div class="flex shrink-0 items-center gap-2">
						<Button
							variant="gray"
							size="sm"
							disabled={isBusy()}
							onClick={() => void loadReports()}
						>
							{loading() ? "Scanning" : "Scan"}
						</Button>
						<Show when={!selectedPath() && summary().repairable > 0}>
							<Button
								variant="dark"
								size="sm"
								disabled={isBusy()}
								onClick={() => void repairAll()}
							>
								{bulkRepair() ? "Repairing" : "Repair all"}
							</Button>
						</Show>
						<Show when={headerRepair()}>
							{(report) => (
								<Button
									variant="dark"
									size="sm"
									disabled={!report().repairable || isBusy()}
									onClick={() => void repairOne(report().projectPath)}
								>
									{repairingPath() === report().projectPath
										? "Repairing"
										: "Repair"}
								</Button>
							)}
						</Show>
					</div>
				</div>
				<div class="flex items-center justify-between gap-3">
					<p class="text-xs text-gray-10">{statusLine()}</p>
				</div>
				<div class="relative h-px w-full overflow-hidden bg-gray-3">
					<div
						class={cx(
							"absolute inset-y-0 left-0 bg-gray-12 transition-[width,opacity] duration-300",
							isBusy() ? "opacity-100" : "opacity-0",
						)}
						style={{ width: `${progressPercent()}%` }}
					/>
				</div>
			</div>

			<div class="flex-1 overflow-y-auto">
				<Show
					when={!error()}
					fallback={
						<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-11">
							{error()}
						</div>
					}
				>
					<Show
						when={slots().length > 0}
						fallback={
							<div class="flex h-full items-center justify-center p-6 text-center text-sm text-gray-10">
								{loading()
									? "Looking for recordings"
									: "No recordings to check"}
							</div>
						}
					>
						<ul class="flex flex-col gap-2 p-4">
							<For each={slots()}>
								{(slot) => (
									<Show
										when={slot.kind === "report" ? slot.report : null}
										fallback={
											<RowSkeleton
												name={slot.kind === "pending" ? slot.name : null}
											/>
										}
									>
										{(report) => (
											<ReportRow
												report={report()}
												expanded={expanded().has(report().projectPath)}
												repairing={repairingPath() === report().projectPath}
												disabled={isBusy()}
												onToggle={() => toggleExpanded(report().projectPath)}
												onRepair={() => void repairOne(report().projectPath)}
											/>
										)}
									</Show>
								)}
							</For>
						</ul>
					</Show>
				</Show>
			</div>
		</div>
	);
}

function RowSkeleton(props: { name: string | null }) {
	return (
		<li
			class={cx(
				"flex items-center gap-3 rounded-lg border border-gray-3 bg-gray-2 px-3",
				ROW_HEIGHT,
			)}
		>
			<div class="size-10 shrink-0 animate-pulse rounded-md bg-gray-3" />
			<div class="flex min-w-0 flex-1 flex-col gap-1.5">
				<Show
					when={props.name}
					fallback={<div class="h-3 w-2/5 animate-pulse rounded bg-gray-3" />}
				>
					{(name) => (
						<span class="truncate text-sm font-medium text-gray-11">
							{name()}
						</span>
					)}
				</Show>
				<div class="h-2.5 w-1/4 animate-pulse rounded bg-gray-3" />
			</div>
		</li>
	);
}

function ReportRow(props: {
	report: RecordingHealthReport;
	expanded: boolean;
	repairing: boolean;
	disabled: boolean;
	onToggle: () => void;
	onRepair: () => void;
}) {
	const [imageBroken, setImageBroken] = createSignal(false);
	const thumbnailSrc = createMemo(() =>
		convertFileSrc(`${props.report.projectPath}/screenshots/display.jpg`),
	);

	const issueCount = () => props.report.issues.length;

	const subtitle = createMemo(() => {
		const parts: string[] = [];
		if (props.report.mode === "studio") parts.push("Studio");
		else if (props.report.mode === "instant") parts.push("Instant");
		if (props.report.recordingStatus) parts.push(props.report.recordingStatus);
		if (issueCount() > 0)
			parts.push(`${issueCount()} issue${issueCount() === 1 ? "" : "s"}`);
		return parts.join(" · ");
	});

	return (
		<li class="overflow-hidden rounded-lg border border-gray-3 bg-gray-2">
			<button
				type="button"
				onClick={props.onToggle}
				class={cx(
					"flex w-full items-center gap-3 px-3 text-left transition-colors hover:bg-gray-3",
					ROW_HEIGHT,
				)}
			>
				<div class="flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-gray-3">
					<Show when={!imageBroken()}>
						<img
							src={thumbnailSrc()}
							alt=""
							class="size-full object-cover"
							onError={() => setImageBroken(true)}
						/>
					</Show>
				</div>
				<div class="flex min-w-0 flex-1 flex-col">
					<div class="flex min-w-0 items-center gap-2">
						<StatusDot status={props.report.status} />
						<span class="truncate text-sm font-medium text-gray-12">
							{props.report.prettyName}
						</span>
					</div>
					<span class="truncate text-xs text-gray-10">{subtitle()}</span>
				</div>
				<div class="flex shrink-0 items-center gap-1">
					<Show when={props.report.repairable}>
						<span
							role="button"
							tabIndex={0}
							aria-disabled={props.disabled || props.repairing}
							onClick={(event) => {
								event.stopPropagation();
								if (!props.disabled && !props.repairing) props.onRepair();
							}}
							onKeyDown={(event) => {
								if (event.key !== "Enter" && event.key !== " ") return;
								event.preventDefault();
								event.stopPropagation();
								if (!props.disabled && !props.repairing) props.onRepair();
							}}
							class={cx(
								"flex h-7 items-center rounded-md border border-gray-4 px-2.5 text-xs font-medium text-gray-12 transition-colors hover:bg-gray-4",
								(props.disabled || props.repairing) &&
									"pointer-events-none opacity-50",
							)}
						>
							{props.repairing ? "Repairing" : "Repair"}
						</span>
					</Show>
					<IconLucideChevronDown
						class={cx(
							"size-4 text-gray-10 transition-transform duration-200",
							props.expanded ? "rotate-180" : "rotate-0",
						)}
					/>
				</div>
			</button>

			<Show when={props.expanded}>
				<ReportDetail report={props.report} />
			</Show>
		</li>
	);
}

function ReportDetail(props: { report: RecordingHealthReport }) {
	const hasIssues = () => props.report.issues.length > 0;
	const hasRepairs = () => props.report.repairs.length > 0;

	return (
		<div class="flex flex-col gap-3 border-t border-gray-3 px-3 py-3">
			<Show when={!hasIssues() && !hasRepairs()}>
				<p class="text-xs text-gray-10">No issues found.</p>
			</Show>

			<Show when={hasIssues()}>
				<ul class="flex flex-col gap-2.5">
					<For each={props.report.issues}>
						{(issue) => (
							<li class="flex items-start gap-2.5">
								<span
									class={cx(
										"mt-1.5 size-1.5 shrink-0 rounded-full",
										issue.severity === "critical" && "bg-red-9",
										issue.severity === "warning" && "bg-amber-9",
										issue.severity === "info" && "bg-gray-9",
									)}
									aria-hidden="true"
								/>
								<div class="min-w-0 flex-1">
									<div class="text-xs font-medium text-gray-12">
										{issue.title}
									</div>
									<div class="mt-0.5 text-xs leading-relaxed text-gray-10">
										{issue.detail}
									</div>
								</div>
							</li>
						)}
					</For>
				</ul>
			</Show>

			<Show when={hasRepairs()}>
				<div
					class={cx(
						"flex flex-col gap-2.5",
						hasIssues() && "border-t border-gray-3 pt-3",
					)}
				>
					<For each={props.report.repairs}>
						{(repair) => (
							<div class="flex items-start gap-2.5">
								<span
									class={cx(
										"mt-1.5 size-1.5 shrink-0 rounded-full",
										repair.status === "performed" && "bg-gray-12",
										repair.status === "failed" && "bg-red-9",
										repair.status === "skipped" && "bg-gray-7",
									)}
									aria-hidden="true"
								/>
								<div class="min-w-0 flex-1">
									<div class="text-xs font-medium text-gray-12">
										{repair.title}
									</div>
									<div class="mt-0.5 text-xs leading-relaxed text-gray-10">
										{repair.detail}
									</div>
								</div>
							</div>
						)}
					</For>
				</div>
			</Show>

			<div class="flex items-center gap-4 border-t border-gray-3 pt-3 text-xs">
				<button
					type="button"
					onClick={() =>
						commands.showWindow({
							Editor: { project_path: props.report.projectPath },
						})
					}
					class="font-medium text-gray-11 transition-colors hover:text-gray-12"
				>
					Open in editor
				</button>
				<button
					type="button"
					onClick={() => commands.openFilePath(props.report.projectPath)}
					class="font-medium text-gray-11 transition-colors hover:text-gray-12"
				>
					Open folder
				</button>
			</div>
		</div>
	);
}

function StatusDot(props: { status: RecordingHealthStatus }) {
	return (
		<Show when={props.status !== "healthy"}>
			<span
				class={cx(
					"size-1.5 shrink-0 rounded-full",
					props.status === "degraded" && "bg-amber-9",
					props.status === "damaged" && "bg-red-9",
					props.status === "missing" && "bg-gray-8",
				)}
				aria-hidden="true"
			/>
		</Show>
	);
}

function pathName(path: string) {
	const normalized = path.replaceAll("\\", "/");
	return normalized.split("/").filter(Boolean).at(-1) ?? "Recording";
}
