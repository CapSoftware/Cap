"use client";

import { Button } from "@cap/ui";
import { faArrowLeft } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import clsx from "clsx";
import { formatDistanceToNowStrict } from "date-fns";
import Link from "next/link";
import {
	type ReactNode,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	cancelLoomImportJobAction,
	retryLoomImportJobAction,
	startLoomImportJobAction,
} from "@/actions/loom-import";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { buildLoomImportReport } from "@/lib/loom-import/report";
import {
	type LoomImportCounts,
	type LoomImportItemView,
	type LoomImportSnapshot,
	loomImportProgress,
} from "@/lib/loom-import/status";
import { Boil, Doodle, LoomMark, Squiggle } from "../_components/doodles";
import { HowImportWorks } from "../_components/how-import-works";
import "../_components/loom-import.css";
import { ROW_HEIGHT, VirtualImportList } from "./import-list";
import { formatHours, UpgradePanel } from "./upgrade-panel";
import { useLoomImportJob } from "./use-loom-import-job";

const numberFormat = new Intl.NumberFormat("en-US");
const LIST_VIEWPORT = ROW_HEIGHT * 9;

type Filter = "all" | "active" | "imported" | "failed" | "skipped";

const FILTERS: { value: Filter; label: string }[] = [
	{ value: "all", label: "All" },
	{ value: "active", label: "In progress" },
	{ value: "imported", label: "In Cap" },
	{ value: "failed", label: "Failed" },
	{ value: "skipped", label: "Skipped" },
];

function filterCount(counts: LoomImportCounts, filter: Filter) {
	switch (filter) {
		case "all":
			return counts.total;
		case "active":
			return counts.checking + counts.ready + counts.queued + counts.importing;
		case "imported":
			return counts.imported;
		case "failed":
			return counts.failed;
		case "skipped":
			return counts.skipped + counts.cancelled;
	}
}

function matchesFilter(item: LoomImportItemView, filter: Filter) {
	switch (filter) {
		case "all":
			return true;
		case "active":
			return (
				item.status === "checking" ||
				item.status === "ready" ||
				item.status === "queued" ||
				item.status === "importing"
			);
		case "imported":
			return item.status === "imported";
		case "failed":
			return item.status === "failed";
		case "skipped":
			return item.status === "skipped" || item.status === "cancelled";
	}
}

function etaLabel(remaining: number, perMinute: number | null) {
	if (!perMinute || remaining <= 0) return null;
	const minutes = remaining / perMinute;
	if (minutes < 1) return "Under a minute left";
	if (minutes < 90) return `About ${Math.ceil(minutes)} min left`;
	return `About ${(minutes / 60).toFixed(1)} hours left`;
}

const StatLine = ({ children }: { children: ReactNode }) => (
	<span className="inline-flex items-center gap-1.5 text-sm text-gray-11">
		{children}
	</span>
);

const Hero = ({
	doodle,
	title,
	body,
	children,
	aside,
}: {
	doodle: Parameters<typeof Doodle>[0]["kind"];
	title: ReactNode;
	body: ReactNode;
	children?: ReactNode;
	aside?: ReactNode;
}) => (
	<section className="li-rise flex flex-col gap-6 rounded-2xl border border-gray-3 bg-gray-1 p-6 sm:flex-row sm:items-center sm:gap-8 sm:p-8">
		<div className="flex size-28 shrink-0 items-center justify-center self-center rounded-2xl bg-gray-2 sm:self-auto">
			<Doodle kind={doodle} className="w-24" />
		</div>
		<div className="flex min-w-0 flex-1 flex-col gap-3">
			<div className="flex flex-col gap-1">
				<h2 className="text-xl font-medium tracking-[-0.01em] text-gray-12">
					{title}
				</h2>
				<p className="text-sm leading-relaxed text-gray-10">{body}</p>
			</div>
			{children}
		</div>
		{aside}
	</section>
);

const STAGES = [
	{ key: "checking", label: "Checking" },
	{ key: "queued", label: "Queued" },
	{ key: "importing", label: "Copying now" },
	{ key: "imported", label: "In Cap" },
] as const;

const PipelineStrip = ({
	counts,
	active,
}: {
	counts: LoomImportCounts;
	active: boolean;
}) => {
	const values = {
		checking: counts.checking,
		queued: counts.queued + counts.ready,
		importing: counts.importing,
		imported: counts.imported,
	};
	return (
		<section
			aria-label="Import pipeline"
			className="grid grid-cols-2 gap-3 sm:grid-cols-[repeat(4,minmax(0,1fr))_auto]"
		>
			{STAGES.map((stage, index) => {
				const value = values[stage.key];
				const next = STAGES[index + 1];
				const flowing =
					active && value > 0 && next !== undefined && stage.key !== "imported";
				return (
					<div
						key={stage.key}
						className={clsx(
							"relative flex flex-col gap-0.5 rounded-xl border px-4 py-3 transition-colors",
							stage.key === "importing" && value > 0
								? "border-blue-6 bg-blue-2"
								: "border-gray-3 bg-gray-1",
						)}
					>
						<NumberFlow
							value={value}
							className="text-xl font-medium tabular-nums text-gray-12"
						/>
						<span className="text-xs text-gray-10">{stage.label}</span>
						{next && (
							<svg
								viewBox="0 0 24 12"
								className="absolute -right-[18px] top-1/2 z-10 hidden h-3 w-6 -translate-y-1/2 sm:block"
								aria-hidden="true"
							>
								<Boil scale={1.2}>
									<path
										className={clsx(
											"li-ink is-thin is-soft li-march",
											!flowing && "is-paused",
										)}
										d="M 2 6 L 20 6"
									/>
									<path
										className="li-ink is-thin is-soft"
										d="M 16 2.5 L 21 6 L 16 9.5"
									/>
								</Boil>
							</svg>
						)}
					</div>
				);
			})}
			<div className="col-span-2 flex items-center gap-4 rounded-xl border border-dashed border-gray-4 px-4 py-3 sm:col-span-1">
				<div className="flex flex-col">
					<span
						className={clsx(
							"text-xl font-medium tabular-nums",
							counts.failed > 0 ? "text-red-11" : "text-gray-12",
						)}
					>
						{numberFormat.format(counts.failed)}
					</span>
					<span className="text-xs text-gray-10">Failed</span>
				</div>
				<div className="flex flex-col">
					<span className="text-xl font-medium tabular-nums text-gray-12">
						{numberFormat.format(counts.skipped + counts.cancelled)}
					</span>
					<span className="text-xs text-gray-10">Skipped</span>
				</div>
			</div>
		</section>
	);
};

export const LoomImportJobView = ({
	initial,
	returnedFromCheckout,
}: {
	initial: LoomImportSnapshot;
	returnedFromCheckout: boolean;
}) => {
	const [watchForUpgrade] = useState(returnedFromCheckout);
	const { summary, items, rate, refresh } = useLoomImportJob(initial, {
		watchForUpgrade,
	});
	const { job, counts } = summary;
	const [filter, setFilter] = useState<Filter>("all");
	const [query, setQuery] = useState("");
	const deferredQuery = useDeferredValue(query.trim().toLowerCase());
	const [howOpen, setHowOpen] = useState(false);
	const [cancelOpen, setCancelOpen] = useState(false);
	const [busy, setBusy] = useState<"start" | "cancel" | "retry" | null>(null);
	const autoStarted = useRef(false);

	const settled =
		counts.imported + counts.failed + counts.skipped + counts.cancelled;
	const importingProgress = useMemo(
		() =>
			items.reduce(
				(sum, item) =>
					item.status === "importing" ? sum + (item.progress ?? 0) : sum,
				0,
			),
		[items],
	);
	const progress = loomImportProgress(counts, importingProgress);
	const checkingProgress =
		counts.total > 0 ? (counts.total - counts.checking) / counts.total : 0;
	const showOwner = summary.owners > 1;
	const thumbs = useMemo(
		() =>
			items
				.filter((item) => item.thumb && item.status !== "failed")
				.slice(0, 12)
				.map((item) => item.thumb as string),
		[items],
	);

	const visible = useMemo(
		() =>
			items.filter((item) => {
				if (!matchesFilter(item, filter)) return false;
				if (!deferredQuery) return true;
				return (
					item.title?.toLowerCase().includes(deferredQuery) ||
					item.url.toLowerCase().includes(deferredQuery) ||
					item.email?.includes(deferredQuery) ||
					item.space?.toLowerCase().includes(deferredQuery) ||
					String(item.row) === deferredQuery
				);
			}),
		[items, filter, deferredQuery],
	);

	const runStart = async (automatic: boolean) => {
		setBusy("start");
		const result = await startLoomImportJobAction(job.id);
		if (!result.ok) toast.error(result.error);
		else if (automatic)
			toast.success("You're on Cap Pro. Your import has started.");
		await refresh().catch(() => undefined);
		setBusy(null);
	};

	useEffect(() => {
		if (!watchForUpgrade || !job.canStart || autoStarted.current) return;
		autoStarted.current = true;
		void runStart(true);
	});

	const runCancel = async () => {
		setBusy("cancel");
		const result = await cancelLoomImportJobAction(job.id);
		if (!result.ok) toast.error(result.error);
		setCancelOpen(false);
		await refresh().catch(() => undefined);
		setBusy(null);
	};

	const runRetry = async () => {
		setBusy("retry");
		const result = await retryLoomImportJobAction(job.id);
		if (!result.ok) toast.error(result.error);
		else if (result.retried === 0) toast("Nothing left to retry.");
		else
			toast.success(`Retrying ${numberFormat.format(result.retried)} videos.`);
		await refresh().catch(() => undefined);
		setBusy(null);
	};

	const downloadReport = () => {
		const csv = buildLoomImportReport(items, window.location.origin);
		const url = URL.createObjectURL(
			new Blob([csv], { type: "text/csv;charset=utf-8" }),
		);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${job.fileName.replace(/\.(csv|tsv|txt)$/i, "")} - Cap import results.csv`;
		link.click();
		URL.revokeObjectURL(url);
	};

	const howStep =
		job.status === "checking"
			? 2
			: job.status === "importing"
				? 3
				: job.status === "completed"
					? 4
					: 0;

	const eta = etaLabel(counts.total - settled, rate);
	const canCancel = job.status === "checking" || job.status === "importing";
	const canRetry =
		counts.failed > 0 &&
		(job.status === "importing" || job.status === "completed");

	return (
		<div className="li-scope flex w-full flex-col">
			<div className="mb-8">
				<Link
					href="/dashboard/import/loom?mode=csv"
					className="mb-4 inline-flex items-center gap-2 text-sm text-gray-10 transition-colors hover:text-gray-12"
				>
					<FontAwesomeIcon className="size-3" icon={faArrowLeft} />
					Import from Loom
				</Link>
				<div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
					<div className="flex min-w-0 items-start gap-4">
						<div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-gray-3">
							<LoomMark size={20} />
						</div>
						<div className="min-w-0">
							<h1 className="truncate text-2xl font-medium text-gray-12">
								{job.fileName}
							</h1>
							<p className="mt-1 text-sm text-gray-10">
								{numberFormat.format(job.totalCount)}{" "}
								{job.totalCount === 1 ? "video" : "videos"} · added{" "}
								{formatDistanceToNowStrict(new Date(job.createdAt), {
									addSuffix: true,
								})}
							</p>
						</div>
					</div>
					<button
						type="button"
						onClick={() => setHowOpen(true)}
						className="shrink-0 self-start text-sm text-gray-11 underline decoration-gray-6 underline-offset-4 transition-colors hover:text-gray-12"
					>
						How does this work?
					</button>
				</div>
			</div>

			<div className="flex w-full max-w-5xl flex-col gap-4">
				{job.status === "checking" && (
					<Hero
						doodle="magnify"
						title="Checking your Loom links"
						body="Reading titles, recording dates and lengths straight from Loom. Private or missing videos get flagged here."
					>
						<Squiggle progress={checkingProgress} />
						<StatLine>
							<span className="tabular-nums">
								{numberFormat.format(counts.total - counts.checking)} of{" "}
								{numberFormat.format(counts.total)} checked
							</span>
						</StatLine>
					</Hero>
				)}

				{job.status === "awaiting_upgrade" && (
					<UpgradePanel
						jobId={job.id}
						videoCount={counts.ready}
						totalDuration={summary.totalDuration}
						owners={summary.owners}
						thumbs={thumbs}
						confirming={watchForUpgrade && !job.canStart}
						canStart={job.canStart}
						starting={busy === "start"}
						onStart={() => runStart(false)}
					/>
				)}

				{job.status === "importing" && (
					<Hero
						doodle="move"
						title={
							<span className="flex flex-wrap items-baseline gap-x-2">
								<NumberFlow value={counts.imported} className="tabular-nums" />
								<span>
									of {numberFormat.format(counts.total)} videos are in Cap
								</span>
							</span>
						}
						body="Videos copy over a few at a time, each into its owner's library with its original title and date. You can close this tab, the import keeps going."
					>
						<Squiggle progress={progress} />
						<div className="flex flex-wrap gap-x-5 gap-y-1">
							<StatLine>
								<span className="tabular-nums">
									{Math.round(progress * 100)}%
								</span>
							</StatLine>
							{rate && (
								<StatLine>
									<span className="tabular-nums">
										{rate >= 10 ? Math.round(rate) : rate.toFixed(1)} videos a
										minute
									</span>
								</StatLine>
							)}
							{eta && <StatLine>{eta}</StatLine>}
							{summary.importedDuration > 0 && (
								<StatLine>
									{formatHours(summary.importedDuration)} of{" "}
									{formatHours(summary.totalDuration)} copied
								</StatLine>
							)}
						</div>
					</Hero>
				)}

				{job.status === "completed" && (
					<Hero
						doodle={counts.imported > 0 ? "done" : "error"}
						title={
							counts.imported > 0
								? `All done. ${numberFormat.format(counts.imported)} ${counts.imported === 1 ? "video is" : "videos are"} in Cap.`
								: "Nothing could be imported"
						}
						body={
							counts.failed > 0
								? `${numberFormat.format(counts.failed)} ${counts.failed === 1 ? "video" : "videos"} didn't make it. You'll find the reason next to each one, and you can try them again.`
								: "Transcripts, summaries and chapters are made the first time each video is opened, so there's nothing left to wait for."
						}
					>
						<Squiggle progress={1} done />
						<div className="flex flex-wrap gap-2">
							<Button href="/dashboard/caps" variant="dark" size="sm">
								Open my Caps
							</Button>
							<Button
								type="button"
								variant="gray"
								size="sm"
								onClick={downloadReport}
							>
								Download Loom to Cap links
							</Button>
						</div>
					</Hero>
				)}

				{job.status === "cancelled" && (
					<Hero
						doodle="stop"
						title="Import stopped"
						body={`${numberFormat.format(counts.imported)} ${counts.imported === 1 ? "video" : "videos"} made it into Cap before you stopped. The rest were left in Loom.`}
					>
						<div className="flex flex-wrap gap-2">
							<Button
								type="button"
								variant="gray"
								size="sm"
								onClick={downloadReport}
							>
								Download Loom to Cap links
							</Button>
						</div>
					</Hero>
				)}

				{job.status !== "awaiting_upgrade" && (
					<PipelineStrip
						counts={counts}
						active={job.status === "importing" || job.status === "checking"}
					/>
				)}

				<section
					aria-label="Videos"
					className="overflow-hidden rounded-2xl border border-gray-3 bg-gray-1"
				>
					<div className="flex flex-col gap-3 border-b border-gray-3 px-4 py-3 lg:flex-row lg:items-center lg:justify-between">
						<div
							role="tablist"
							aria-label="Filter videos"
							className="flex flex-wrap gap-1"
						>
							{FILTERS.map((option) => {
								const count = filterCount(counts, option.value);
								return (
									<button
										key={option.value}
										type="button"
										role="tab"
										aria-selected={filter === option.value}
										onClick={() => setFilter(option.value)}
										className={clsx(
											"inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-sm transition-colors",
											filter === option.value
												? "bg-gray-12 text-gray-1"
												: "text-gray-11 hover:bg-gray-3 hover:text-gray-12",
										)}
									>
										{option.label}
										<span
											className={clsx(
												"tabular-nums",
												filter === option.value ? "text-gray-6" : "text-gray-9",
											)}
										>
											{numberFormat.format(count)}
										</span>
									</button>
								);
							})}
						</div>
						<div className="flex flex-wrap items-center gap-2">
							<input
								type="search"
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="Search titles, owners, links"
								aria-label="Search videos"
								className="h-8 w-full rounded-full border border-gray-4 bg-gray-2 px-3 text-sm text-gray-12 outline-none transition-colors placeholder:text-gray-9 focus:border-blue-8 sm:w-56"
							/>
							{canRetry && (
								<Button
									type="button"
									variant="gray"
									size="xs"
									spinner={busy === "retry"}
									disabled={busy !== null}
									onClick={runRetry}
								>
									Retry {numberFormat.format(counts.failed)} failed
								</Button>
							)}
							{settled > 0 &&
								job.status !== "completed" &&
								job.status !== "cancelled" && (
									<Button
										type="button"
										variant="gray"
										size="xs"
										onClick={downloadReport}
									>
										Download results
									</Button>
								)}
							{canCancel && (
								<Button
									type="button"
									variant="gray"
									size="xs"
									disabled={busy !== null}
									onClick={() => setCancelOpen(true)}
								>
									Stop import
								</Button>
							)}
						</div>
					</div>
					<VirtualImportList
						items={visible}
						viewport={LIST_VIEWPORT}
						showOwner={showOwner}
						empty={
							deferredQuery
								? "No videos match that search."
								: "Nothing here right now."
						}
					/>
				</section>

				<p className="px-1 text-xs leading-relaxed text-gray-10">
					AI titles, summaries and chapters for imported videos are made the
					first time each video is opened. Need more than{" "}
					{numberFormat.format(2000)} videos? Start another import with the next
					CSV, they run side by side.
				</p>
			</div>

			<HowImportWorks
				open={howOpen}
				onOpenChange={setHowOpen}
				initialStep={howStep}
			/>
			<ConfirmationDialog
				open={cancelOpen}
				title="Stop this import?"
				description={`Videos already in Cap stay there. The ${numberFormat.format(
					counts.queued + counts.ready + counts.checking,
				)} that haven't started won't be imported.`}
				confirmLabel="Stop import"
				confirmVariant="destructive"
				loading={busy === "cancel"}
				onConfirm={runCancel}
				onCancel={() => setCancelOpen(false)}
			/>
		</div>
	);
};
