"use client";

import { Button, Card } from "@cap/ui";
import { Effect } from "effect";
import * as Cause from "effect/Cause";
import {
	AlertCircle,
	ArrowLeft,
	CheckCircle2,
	CircleDashed,
	Download,
	LoaderCircle,
	RefreshCw,
} from "lucide-react";
import Link from "next/link";
import { useEffectMutation, useEffectQuery } from "@/lib/EffectRuntime";
import type { LoomBatchStatus as LoomBatchStatusData } from "@/lib/loom-batch";

const DISPLAY_ROW_LIMIT = 100;

class BatchStatusError extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function formatDate(value: string | null) {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	return new Intl.DateTimeFormat(undefined, {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(date);
}

function formatSourceDate(value: string | null) {
	if (!value) return "—";
	if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
		const date = new Date(`${value}T00:00:00Z`);
		if (Number.isNaN(date.getTime())) return "—";
		return new Intl.DateTimeFormat(undefined, {
			dateStyle: "medium",
			timeZone: "UTC",
		}).format(date);
	}
	return formatDate(value);
}

function unwrapCause(error: unknown) {
	if (!Cause.isCause(error)) return error;
	const failure = Cause.failureOption(error);
	return failure._tag === "Some" ? failure.value : error;
}

function errorStatus(error: unknown) {
	const unwrappedError = unwrapCause(error);
	return unwrappedError instanceof BatchStatusError
		? unwrappedError.status
		: undefined;
}

function isNonRetryableError(error: unknown) {
	const status = errorStatus(error);
	return status !== undefined && status >= 400 && status < 500;
}

function errorMessage(error: unknown) {
	if (errorStatus(error) === 401) {
		return "Your Cap session has expired. Sign in again to view this import.";
	}
	if (errorStatus(error) === 403) {
		return "You do not have permission to view this organization's Loom import.";
	}
	if (errorStatus(error) === 404) {
		return "This Loom import could not be found for the selected organization.";
	}
	const unwrappedError = unwrapCause(error);
	if (unwrappedError instanceof Error && unwrappedError.message) {
		return unwrappedError.message;
	}
	return "This Loom import link is incomplete.";
}

function phaseLabel(phase: LoomBatchStatusData["phase"]) {
	if (phase === "queued") return "Queued";
	if (phase === "preparing") return "Preparing imports";
	if (phase === "dispatching") return "Starting Cap videos";
	if (phase === "monitoring") return "Finishing video processing";
	if (phase === "complete") return "Complete";
	return "Needs attention";
}

function stateLabel(state: LoomBatchStatusData["state"]) {
	if (state === "queued") return "Queued";
	if (state === "running") return "In progress";
	if (state === "dispatched") return "Started";
	if (state === "complete") return "Complete";
	return "Needs attention";
}

function rowStateLabel(state: LoomBatchStatusData["rows"][number]["state"]) {
	if (state === "queued") return "Queued";
	if (state === "processing") return "Processing";
	if (state === "ready") return "Ready";
	if (state === "failed") return "Failed";
	return "Uncertain";
}

function rowStateClass(state: LoomBatchStatusData["rows"][number]["state"]) {
	if (state === "ready") return "bg-green-3 text-green-11";
	if (state === "failed") return "bg-red-3 text-red-11";
	if (state === "uncertain") return "bg-yellow-3 text-yellow-11";
	return "bg-blue-3 text-blue-11";
}

function csvCell(value: string | number | boolean | null | undefined) {
	let text = String(value ?? "");
	let prefixLength = 0;
	while (prefixLength < text.length) {
		const code = text.charCodeAt(prefixLength);
		if (!(code <= 32 || (code >= 127 && code <= 159))) break;
		prefixLength += 1;
	}
	if (prefixLength < text.length && "=+-@".includes(text[prefixLength] ?? ""))
		text = `'${text}`;
	return `"${text.replaceAll('"', '""')}"`;
}

const isNonNegativeInteger = (value: unknown): value is number =>
	typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isCalendarDate = (value: unknown): value is string =>
	typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
	Boolean(value) && typeof value === "object" && !Array.isArray(value);

function isStatusRow(value: unknown): boolean {
	if (!isRecord(value)) return false;
	return (
		isNonNegativeInteger(value.rowNumber) &&
		typeof value.userEmail === "string" &&
		typeof value.loomVideoId === "string" &&
		typeof value.state === "string" &&
		["queued", "processing", "ready", "failed", "uncertain"].includes(
			value.state,
		) &&
		(value.spaceName === undefined || typeof value.spaceName === "string") &&
		(value.videoId === undefined || typeof value.videoId === "string") &&
		(value.error === undefined || typeof value.error === "string") &&
		(value.existing === undefined || typeof value.existing === "boolean")
	);
}

function isStatusResponse(value: unknown): value is LoomBatchStatusData {
	if (!isRecord(value)) return false;
	const candidate = value;
	const counts = candidate.counts;
	const source = candidate.source;
	if (
		!isRecord(counts) ||
		!isRecord(source) ||
		!Array.isArray(candidate.rows)
	) {
		return false;
	}
	return (
		typeof candidate.operationId === "string" &&
		typeof candidate.organizationId === "string" &&
		typeof candidate.state === "string" &&
		["queued", "running", "dispatched", "complete", "failed"].includes(
			candidate.state,
		) &&
		typeof candidate.phase === "string" &&
		[
			"queued",
			"preparing",
			"dispatching",
			"monitoring",
			"complete",
			"failed",
		].includes(candidate.phase) &&
		candidate.rows.every(isStatusRow) &&
		typeof candidate.rowsTruncated === "boolean" &&
		(candidate.currentRowNumber === null ||
			isNonNegativeInteger(candidate.currentRowNumber)) &&
		isNonNegativeInteger(counts.total) &&
		isNonNegativeInteger(counts.queued) &&
		isNonNegativeInteger(counts.processing) &&
		isNonNegativeInteger(counts.ready) &&
		isNonNegativeInteger(counts.failed) &&
		isNonNegativeInteger(counts.uncertain) &&
		typeof source.workspace === "string" &&
		isCalendarDate(source.from) &&
		isCalendarDate(source.to) &&
		isNonNegativeInteger(source.totalRows) &&
		isNonNegativeInteger(source.omittedRows) &&
		typeof candidate.createdAt === "string" &&
		typeof candidate.updatedAt === "string" &&
		(candidate.completedAt === null ||
			typeof candidate.completedAt === "string") &&
		(candidate.error === undefined || typeof candidate.error === "string")
	);
}

function getBatchStatusEffect({
	operationId,
	organizationId,
	report,
	signal,
}: {
	operationId: string;
	organizationId: string;
	report?: boolean;
	signal?: AbortSignal;
}) {
	return Effect.gen(function* () {
		const url = new URL(
			"/api/extension/import-loom/batch",
			window.location.origin,
		);
		url.searchParams.set("operationId", operationId);
		url.searchParams.set("organizationId", organizationId);
		if (report) url.searchParams.set("report", "1");
		const response = yield* Effect.tryPromise({
			try: () => fetch(url, { cache: "no-store", signal }),
			catch: (cause: unknown) =>
				cause instanceof Error
					? cause
					: new Error("Failed to load Loom import status."),
		});

		if (!response.ok) {
			return yield* Effect.fail(
				new BatchStatusError(
					response.status,
					`Loom import status request failed (${response.status}).`,
				),
			);
		}

		const responseBody: unknown = yield* Effect.tryPromise({
			try: () => response.json() as Promise<unknown>,
			catch: (cause: unknown) =>
				cause instanceof Error
					? cause
					: new Error("The Loom import status response was invalid."),
		});
		if (!isStatusResponse(responseBody)) {
			return yield* Effect.fail(
				new BatchStatusError(
					502,
					"Cap returned an invalid Loom import status response.",
				),
			);
		}
		const status = responseBody;
		if (
			status.operationId !== operationId ||
			status.organizationId !== organizationId
		) {
			return yield* Effect.fail(
				new BatchStatusError(
					502,
					"Cap returned a status for a different Loom import.",
				),
			);
		}
		if (
			report &&
			(status.rowsTruncated || status.rows.length < status.counts.total)
		) {
			return yield* Effect.fail(
				new BatchStatusError(
					502,
					"Cap returned an incomplete Loom import report.",
				),
			);
		}

		return status;
	});
}

function buildCsvReport(status: LoomBatchStatusData) {
	const header = [
		"rowNumber",
		"userEmail",
		"spaceName",
		"loomVideoId",
		"state",
		"videoId",
		"existing",
		"error",
	].join(",");
	const rows = status.rows.map((row) =>
		[
			row.rowNumber,
			row.userEmail,
			row.spaceName,
			row.loomVideoId,
			row.state,
			row.videoId,
			row.existing,
			row.error,
		]
			.map(csvCell)
			.join(","),
	);
	const blob = new Blob([`\uFEFF${[header, ...rows].join("\r\n")}`], {
		type: "text/csv;charset=utf-8",
	});
	const url = URL.createObjectURL(blob);
	const link = document.createElement("a");
	link.href = url;
	link.download = `loom-import-${status.operationId.replace(/[^a-zA-Z0-9_-]/g, "_")}.csv`;
	link.click();
	window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function Stat({ label, value }: { label: string; value: number }) {
	return (
		<div className="p-4 bg-gray-2">
			<p className="text-xl font-medium tabular-nums text-gray-12">
				{value.toLocaleString()}
			</p>
			<p className="mt-1 text-xs text-gray-10">{label}</p>
		</div>
	);
}

export function LoomBatchStatus({
	operationId,
	organizationId,
}: {
	operationId?: string;
	organizationId?: string;
}) {
	const query = useEffectQuery({
		queryKey: ["loom-batch-status", operationId, organizationId],
		queryFn: (context) => {
			if (!operationId || !organizationId) {
				return Effect.fail(
					new BatchStatusError(400, "This Loom import link is incomplete."),
				);
			}
			return getBatchStatusEffect({
				operationId,
				organizationId,
				signal: context.signal,
			});
		},
		enabled: Boolean(operationId && organizationId),
		throwOnDefect: true,
		staleTime: 0,
		retry: (failureCount, error) =>
			!isNonRetryableError(error) && failureCount < 3,
		refetchInterval: (currentQuery) => {
			if (isNonRetryableError(currentQuery.state.error)) return false;
			const status = currentQuery.state.data;
			return status &&
				(status.phase === "monitoring" ||
					status.state === "queued" ||
					status.state === "running" ||
					status.counts.processing > 0)
				? status.counts.total > 500
					? 15_000
					: 3_000
				: false;
		},
	});
	const reportMutation = useEffectMutation({
		throwOnDefect: true,
		mutationFn: () => {
			if (!operationId || !organizationId) {
				return Effect.fail(
					new BatchStatusError(400, "This Loom import link is incomplete."),
				);
			}
			return getBatchStatusEffect({
				operationId,
				organizationId,
				report: true,
			});
		},
		onSuccess: (report) => buildCsvReport(report),
	});

	if (query.isLoading) {
		return (
			<div className="flex items-center justify-center min-h-80 text-gray-10">
				<LoaderCircle className="mr-2 size-4 animate-spin" />
				Loading Loom import status...
			</div>
		);
	}

	if (query.isError || !query.data) {
		const status = errorStatus(query.error);
		return (
			<div className="flex flex-col gap-6 max-w-2xl">
				<Link
					href="/dashboard/caps"
					className="inline-flex gap-2 items-center text-sm text-gray-10 hover:text-gray-12"
				>
					<ArrowLeft className="size-3.5" />
					Back to Cap videos
				</Link>
				<Card className="border-red-4 bg-red-2">
					<div className="flex gap-3 items-start">
						<AlertCircle className="mt-0.5 size-5 text-red-10" />
						<div>
							<h1 className="text-lg font-medium text-gray-12">
								Unable to load Loom import
							</h1>
							<p className="mt-2 text-sm text-gray-10">
								{errorMessage(query.error)}
							</p>
							{status === 401 && (
								<Button className="mt-4" href="/login" size="sm">
									Sign in to Cap
								</Button>
							)}
							{status !== 401 && status !== 403 && status !== 404 && (
								<Button
									className="mt-4"
									size="sm"
									variant="outline"
									onClick={() => query.refetch()}
									icon={<RefreshCw className="size-3.5" />}
								>
									Try again
								</Button>
							)}
						</div>
					</div>
				</Card>
			</div>
		);
	}

	const status = query.data;
	const displayedRows = status.rows.slice(0, DISPLAY_ROW_LIMIT);
	const progressTotal = status.counts.total;
	const progressValue = Math.min(
		status.counts.ready + status.counts.failed + status.counts.uncertain,
		progressTotal,
	);
	const progressPercent =
		progressTotal === 0
			? 100
			: Math.round((progressValue / progressTotal) * 100);
	const isMonitoring = status.phase === "monitoring";
	const hasIssues =
		status.phase === "failed" ||
		status.state === "failed" ||
		status.counts.failed > 0 ||
		status.counts.uncertain > 0;
	const hasPendingRows =
		status.counts.queued > 0 || status.counts.processing > 0;
	const isTerminal =
		!hasPendingRows &&
		(status.state === "complete" ||
			status.state === "failed" ||
			status.phase === "complete" ||
			status.phase === "failed");
	const hasOngoingIssues = hasIssues && !isTerminal;

	return (
		<div className="flex flex-col gap-6 w-full max-w-5xl">
			<div className="flex flex-wrap gap-4 justify-between items-start">
				<div>
					<Link
						href="/dashboard/caps"
						className="inline-flex gap-2 items-center mb-4 text-sm text-gray-10 hover:text-gray-12"
					>
						<ArrowLeft className="size-3.5" />
						Back to Cap videos
					</Link>
					<h1 className="text-2xl font-medium text-gray-12">
						Importing your Loom videos
					</h1>
					<p className="mt-1 text-sm text-gray-10">
						{phaseLabel(status.phase)} · {stateLabel(status.state)}
					</p>
				</div>
				<div className="flex flex-col gap-2 items-end">
					<Button
						size="sm"
						variant="outline"
						onClick={() => reportMutation.mutate()}
						disabled={reportMutation.isPending}
						spinner={reportMutation.isPending}
						icon={
							!reportMutation.isPending && <Download className="size-3.5" />
						}
					>
						Download full row report
					</Button>
					{reportMutation.isError && (
						<p className="max-w-xs text-xs text-right text-red-10" role="alert">
							{errorMessage(reportMutation.error)}
						</p>
					)}
				</div>
			</div>

			<Card>
				<div className="grid gap-4 sm:grid-cols-2">
					<div>
						<p className="text-xs text-gray-10">Loom workspace</p>
						<p className="mt-1 font-medium text-gray-12">
							{status.source.workspace}
						</p>
					</div>
					<div>
						<p className="text-xs text-gray-10">Organization scope</p>
						<p className="mt-1 font-mono text-xs break-all text-gray-12">
							{status.organizationId}
						</p>
					</div>
					<div>
						<p className="text-xs text-gray-10">Source window</p>
						<p className="mt-1 text-sm text-gray-12">
							{formatSourceDate(status.source.from)} –{" "}
							{formatSourceDate(status.source.to)}
						</p>
					</div>
					<div>
						<p className="text-xs text-gray-10">Last updated</p>
						<p className="mt-1 text-sm text-gray-12">
							{formatDate(status.updatedAt)}
						</p>
					</div>
				</div>
				<p className="pt-4 mt-4 text-sm border-t text-gray-10 border-gray-3">
					{status.source.omittedRows > 0
						? `${status.source.omittedRows.toLocaleString()} source records were not importable. The full source report remains in the extension.`
						: "All eligible source rows were included."}{" "}
					Organization scope comes from the import receipt; Cap will not switch
					your active organization on this page.
				</p>
			</Card>

			<Card>
				<div className="flex gap-3 items-center">
					{hasIssues ? (
						<AlertCircle className="size-5 text-red-10" />
					) : isMonitoring ? (
						<LoaderCircle className="size-5 animate-spin text-blue-10" />
					) : status.phase === "complete" ? (
						<CheckCircle2 className="size-5 text-green-10" />
					) : (
						<CircleDashed className="size-5 text-blue-10" />
					)}
					<div>
						<h2 className="font-medium text-gray-12">
							{hasOngoingIssues
								? "Import is continuing with issues"
								: hasIssues
									? "Finished with issues"
									: isMonitoring
										? "Cap is finishing video processing"
										: status.phase === "complete"
											? "Loom import complete"
											: "Cap is preparing your import"}
						</h2>
						<p className="mt-1 text-sm text-gray-10">
							{hasOngoingIssues
								? "Some rows need attention while the import continues. Check Cap before retrying, and do not blindly retry uncertain rows."
								: hasIssues
									? "Check Cap before retrying. Do not blindly retry uncertain rows."
									: isMonitoring
										? "The browser handoff is finished. You can leave this page open or come back later."
										: "Your Loom account is not changed while Cap imports these videos."}
						</p>
					</div>
				</div>
				<div className="mt-5">
					<div className="flex justify-between mb-2 text-xs text-gray-10">
						<span>
							{progressValue.toLocaleString()} of{" "}
							{progressTotal.toLocaleString()} rows classified
						</span>
						<span className="tabular-nums">{progressPercent}%</span>
					</div>
					<div className="overflow-hidden w-full h-2 rounded-full bg-gray-4">
						<div
							className="h-full rounded-full bg-blue-9 transition-[width]"
							style={{ width: `${progressPercent}%` }}
						/>
					</div>
				</div>
				{status.currentRowNumber !== null && (
					<p className="mt-3 text-xs text-gray-10">
						Current row: {status.currentRowNumber.toLocaleString()}
					</p>
				)}
			</Card>

			<div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border bg-gray-4 border-gray-4 sm:grid-cols-5">
				<Stat label="Total" value={status.counts.total} />
				<Stat label="Queued" value={status.counts.queued} />
				<Stat label="Processing" value={status.counts.processing} />
				<Stat label="Ready" value={status.counts.ready} />
				<Stat
					label="Failed / uncertain"
					value={status.counts.failed + status.counts.uncertain}
				/>
			</div>

			{status.error && (
				<div className="p-4 text-sm rounded-xl border border-red-4 bg-red-2 text-red-11">
					{status.error}
				</div>
			)}

			<Card className="p-0 overflow-hidden">
				<div className="flex flex-wrap gap-3 justify-between items-center p-5 border-b border-gray-3">
					<div>
						<h2 className="font-medium text-gray-12">Row results</h2>
						<p className="mt-1 text-xs text-gray-10">
							{status.rowsTruncated
								? `Showing the first ${DISPLAY_ROW_LIMIT.toLocaleString()} rows. Download the report for all rows.`
								: "Download a local copy if you need to review the result later."}
						</p>
					</div>
					<Link
						href="/dashboard/import/loom"
						className="text-sm text-blue-10 hover:text-blue-11"
					>
						Start another import
					</Link>
				</div>
				<div className="overflow-x-auto">
					<table className="w-full text-left text-sm">
						<thead className="text-xs text-gray-10 bg-gray-2">
							<tr>
								<th className="px-5 py-3 font-medium">Row</th>
								<th className="px-5 py-3 font-medium">Owner</th>
								<th className="px-5 py-3 font-medium">Space</th>
								<th className="px-5 py-3 font-medium">Status</th>
								<th className="px-5 py-3 font-medium">Details</th>
							</tr>
						</thead>
						<tbody className="divide-y divide-gray-3">
							{displayedRows.map((row) => (
								<tr key={row.rowNumber}>
									<td className="px-5 py-3 tabular-nums text-gray-10">
										{row.rowNumber}
									</td>
									<td className="px-5 py-3 text-gray-12">{row.userEmail}</td>
									<td className="px-5 py-3 text-gray-10">
										{row.spaceName || "—"}
									</td>
									<td className="px-5 py-3">
										<span
											className={`inline-flex px-2 py-1 text-xs rounded-full ${rowStateClass(row.state)}`}
										>
											{rowStateLabel(row.state)}
										</span>
									</td>
									<td className="max-w-xs px-5 py-3 text-xs text-gray-10">
										{row.error ||
											(row.existing ? "Already imported" : row.videoId || "—")}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</Card>

			<p className="text-xs leading-5 text-gray-10">
				Cap does not change or delete your Loom videos, and Loom folders are not
				copied. Imported videos use Cap's configured default privacy. For
				uncertain rows, check Cap before contacting support instead of blindly
				retrying the import.
			</p>
		</div>
	);
}
