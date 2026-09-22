"use client";

import { Button } from "@cap/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
	createConciergeLoomFileUpload,
	finishConciergeLoomFileUpload,
	importFromLoomCsvForConcierge,
	type LoomCsvImportRow,
	type LoomCsvImportRowResult,
} from "@/actions/loom";
import {
	getLoomMigrationOperatorQueue,
	updateLoomMigrationStatus,
} from "@/actions/loom-concierge";
import type { OperatorLoomMigrationView } from "@/lib/loom-concierge";
import { parseConciergeLoomCsv } from "@/lib/loom-csv";
import {
	LOOM_MIGRATION_STATUS_LABELS,
	type LoomMigrationStatus,
} from "@/lib/loom-migration-state";
import { uploadWithTarget } from "@/utils/upload-target";

const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 1500;

function delay(ms: number) {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function QueueItem({ request }: { request: OperatorLoomMigrationView }) {
	const queryClient = useQueryClient();
	const [nextStatus, setNextStatus] = useState<LoomMigrationStatus>(
		request.status,
	);
	const [message, setMessage] = useState(request.capMessage ?? "");
	const [expectedVideoCount, setExpectedVideoCount] = useState(
		request.expectedVideoCount?.toString() ?? "",
	);
	const [importedVideoCount, setImportedVideoCount] = useState(
		request.importedVideoCount.toString(),
	);
	const [verified, setVerified] = useState(false);
	const [csvRows, setCsvRows] = useState<LoomCsvImportRow[]>([]);
	const [processedRows, setProcessedRows] = useState(0);
	const [startedRows, setStartedRows] = useState(0);
	const [failedRows, setFailedRows] = useState<LoomCsvImportRowResult[]>([]);
	const [fileLoomUrl, setFileLoomUrl] = useState("");
	const [fileOwnerEmail, setFileOwnerEmail] = useState("");
	const [fileSpaceName, setFileSpaceName] = useState("");
	const [fileTitle, setFileTitle] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [uploadPercent, setUploadPercent] = useState(0);

	useEffect(() => {
		setNextStatus(request.status);
		setMessage(request.capMessage ?? "");
		setExpectedVideoCount(request.expectedVideoCount?.toString() ?? "");
		setImportedVideoCount(request.importedVideoCount.toString());
		setVerified(false);
	}, [
		request.status,
		request.capMessage,
		request.expectedVideoCount,
		request.importedVideoCount,
	]);

	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: ["loom-migration-queue"] });
	const statusMutation = useMutation({
		mutationFn: () =>
			updateLoomMigrationStatus({
				requestId: request.id,
				nextStatus,
				message,
				verified,
				expectedVideoCount:
					expectedVideoCount.trim() === "" ? null : Number(expectedVideoCount),
				importedVideoCount: Number(importedVideoCount),
			}),
		onSuccess: async () => {
			await refresh();
			toast.success("Migration status updated.");
		},
		onError: (error) => toast.error(error.message),
	});
	const importMutation = useMutation({
		mutationFn: async () => {
			if (csvRows.length === 0) throw new Error("Choose a Loom CSV first.");
			setProcessedRows(0);
			setStartedRows(0);
			setFailedRows([]);
			let started = 0;
			const failures: LoomCsvImportRowResult[] = [];
			for (let index = 0; index < csvRows.length; index += BATCH_SIZE) {
				const batch = csvRows.slice(index, index + BATCH_SIZE);
				const result = await importFromLoomCsvForConcierge({
					requestId: request.id,
					rows: batch,
				});
				started += result.importedCount;
				failures.push(...result.results.filter((row) => !row.success));
				setProcessedRows(index + batch.length);
				setStartedRows(started);
				setFailedRows([...failures]);
				if (index + BATCH_SIZE < csvRows.length) await delay(BATCH_DELAY_MS);
			}
			return { started, failures };
		},
		onSuccess: async (result) => {
			await refresh();
			toast.success(
				`${result.started} imports started. ${result.failures.length} rows need review. Wait for processing and reconcile the library before completion.`,
			);
		},
		onError: async (error) => {
			await refresh();
			toast.error(
				`${error.message} Check the rows already started before retrying.`,
			);
		},
	});
	const fileMutation = useMutation({
		mutationFn: async () => {
			if (!file || !fileLoomUrl.trim() || !fileOwnerEmail.trim()) {
				throw new Error("Choose an MP4 file, Loom URL, and destination owner.");
			}
			if (!file.name.toLowerCase().endsWith(".mp4")) {
				throw new Error("Choose an MP4 downloaded from Loom.");
			}
			if (file.size === 0) throw new Error("The MP4 file is empty.");
			const prepared = await createConciergeLoomFileUpload({
				requestId: request.id,
				loomUrl: fileLoomUrl,
				userEmail: fileOwnerEmail,
				spaceName: fileSpaceName,
				videoTitle: fileTitle.trim() || file.name.replace(/\.mp4$/i, ""),
			});
			setUploadPercent(0);
			await uploadWithTarget({
				target: prepared.uploadTarget,
				body: file,
				fileName: file.name,
				onProgress: ({ loaded, total }) => {
					if (total > 0) setUploadPercent(Math.round((loaded / total) * 100));
				},
			});
			return finishConciergeLoomFileUpload({
				requestId: request.id,
				videoId: prepared.videoId,
			});
		},
		onSuccess: async (result) => {
			await refresh();
			setFile(null);
			setUploadPercent(0);
			toast.success(
				result.status === "started"
					? "Loom file uploaded. Processing has started."
					: "Loom file uploaded. Processing was already underway.",
			);
		},
		onError: async (error) => {
			await refresh();
			toast.error(
				`${error.message} The same Loom URL can be retried after checking its upload.`,
			);
		},
	});

	return (
		<div className="rounded-xl border border-gray-4 bg-gray-1 p-5">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<h2 className="text-lg font-medium text-gray-12">
						{request.organizationName}
					</h2>
					<p className="mt-1 text-xs text-gray-10">
						{request.requestedByEmail} · {request.organizationId} · Requested{" "}
						{new Date(request.createdAt).toLocaleDateString()}
					</p>
				</div>
				<span className="rounded-full bg-gray-3 px-3 py-1 text-xs text-gray-11">
					{LOOM_MIGRATION_STATUS_LABELS[request.status]}
				</span>
			</div>
			<div className="mt-4 grid gap-2 text-sm text-gray-11 sm:grid-cols-2">
				<p>Loom workspace: {request.workspaceName || "Not provided"}</p>
				<p>
					Loom invite:{" "}
					{request.invitedAt ? "Marked as sent" : "Waiting for customer"}
				</p>
				<p>Videos queued: {request.queuedVideoCount}</p>
				<p>Verified videos: {request.importedVideoCount}</p>
				<p>Imports starting: {request.activeImportCount}</p>
			</div>
			{request.customerNote && (
				<div className="mt-4 rounded-lg bg-gray-3 p-3 text-sm text-gray-11">
					Customer note: {request.customerNote}
				</div>
			)}
			{request.customerReply && (
				<div className="mt-3 rounded-lg bg-blue-3 p-3 text-sm text-gray-11">
					Latest customer answer: {request.customerReply}
				</div>
			)}

			<div className="mt-5 border-t border-gray-4 pt-5">
				<h3 className="font-medium text-gray-12">Import a mapped Loom CSV</h3>
				<p className="mt-1 text-xs text-gray-10">
					Use loom_video_url,user_email,space_name. The destination is this Cap
					organization; imports run in batches of 10. Started jobs still need
					terminal processing checks.
				</p>
				<label
					className="mt-3 block text-sm text-gray-11"
					htmlFor={`loom-csv-${request.id}`}
				>
					Loom CSV
				</label>
				<input
					accept=".csv,text/csv"
					className="mt-2 block w-full text-sm text-gray-11"
					disabled={importMutation.isPending}
					id={`loom-csv-${request.id}`}
					onChange={async (event) => {
						const file = event.target.files?.[0];
						if (!file) return;
						try {
							setCsvRows(parseConciergeLoomCsv(await file.text()));
							setProcessedRows(0);
							setStartedRows(0);
							setFailedRows([]);
						} catch (error) {
							setCsvRows([]);
							toast.error(
								error instanceof Error
									? error.message
									: "Could not read the CSV.",
							);
						}
					}}
					type="file"
				/>
				{csvRows.length > 0 && (
					<p className="mt-2 text-xs text-gray-10">
						{csvRows.length} rows ready. Review the source inventory and owner
						mapping before import.
					</p>
				)}
				<Button
					className="mt-3"
					disabled={importMutation.isPending || csvRows.length === 0}
					onClick={() => importMutation.mutate()}
					size="sm"
					variant="dark"
				>
					{importMutation.isPending
						? `Importing ${processedRows}/${csvRows.length}`
						: "Start import"}
				</Button>
				{processedRows > 0 && (
					<p className="mt-2 text-xs text-gray-10">
						{startedRows} jobs started; {failedRows.length} rows failed to
						start.
					</p>
				)}
				{failedRows.length > 0 && (
					<ul className="mt-3 max-h-48 list-inside list-disc overflow-y-auto text-xs text-red-11">
						{failedRows.map((row) => (
							<li key={row.rowNumber}>
								Row {row.rowNumber}: {row.error || "Could not start import."}
							</li>
						))}
					</ul>
				)}
			</div>

			<form
				className="mt-5 grid gap-3 border-t border-gray-4 pt-5"
				onSubmit={(event) => {
					event.preventDefault();
					fileMutation.mutate();
				}}
			>
				<h3 className="font-medium text-gray-12">
					Upload a restricted Loom video
				</h3>
				<p className="text-xs text-gray-10">
					Use this when the CSV import cannot download a video. Download an MP4
					from Loom with an account that has permission, then map it to its Loom
					link and Cap owner. Restricted Library videos may need explicit
					access.
				</p>
				<div className="grid gap-3 sm:grid-cols-2">
					<label
						className="text-sm text-gray-11"
						htmlFor={`loom-file-url-${request.id}`}
					>
						Loom video URL
						<input
							className="mt-1 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-gray-12"
							id={`loom-file-url-${request.id}`}
							onChange={(event) => setFileLoomUrl(event.target.value)}
							placeholder="https://www.loom.com/share/..."
							type="url"
							value={fileLoomUrl}
						/>
					</label>
					<label
						className="text-sm text-gray-11"
						htmlFor={`loom-file-owner-${request.id}`}
					>
						Cap owner email
						<input
							className="mt-1 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-gray-12"
							id={`loom-file-owner-${request.id}`}
							onChange={(event) => setFileOwnerEmail(event.target.value)}
							type="email"
							value={fileOwnerEmail}
						/>
					</label>
					<label
						className="text-sm text-gray-11"
						htmlFor={`loom-file-space-${request.id}`}
					>
						Cap space (optional)
						<input
							className="mt-1 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-gray-12"
							id={`loom-file-space-${request.id}`}
							onChange={(event) => setFileSpaceName(event.target.value)}
							value={fileSpaceName}
						/>
					</label>
					<label
						className="text-sm text-gray-11"
						htmlFor={`loom-file-title-${request.id}`}
					>
						Video title (defaults to file name)
						<input
							className="mt-1 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-gray-12"
							id={`loom-file-title-${request.id}`}
							onChange={(event) => setFileTitle(event.target.value)}
							value={fileTitle}
						/>
					</label>
				</div>
				<label
					className="text-sm text-gray-11"
					htmlFor={`loom-file-mp4-${request.id}`}
				>
					Downloaded Loom MP4
					<input
						accept=".mp4,video/mp4"
						className="mt-1 block w-full text-gray-11"
						id={`loom-file-mp4-${request.id}`}
						onChange={(event) => setFile(event.target.files?.[0] ?? null)}
						type="file"
					/>
				</label>
				<Button
					disabled={fileMutation.isPending || importMutation.isPending || !file}
					size="sm"
					type="submit"
					variant="dark"
				>
					{fileMutation.isPending
						? `Uploading ${uploadPercent}%`
						: "Upload and process"}
				</Button>
			</form>

			<form
				className="mt-5 grid gap-4 border-t border-gray-4 pt-5"
				onSubmit={(event) => {
					event.preventDefault();
					statusMutation.mutate();
				}}
			>
				<h3 className="font-medium text-gray-12">Update customer status</h3>
				<div className="grid gap-4 sm:grid-cols-3">
					<div>
						<label
							className="block text-sm text-gray-11"
							htmlFor={`loom-status-${request.id}`}
						>
							Status
						</label>
						<select
							className="mt-2 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-sm text-gray-12"
							id={`loom-status-${request.id}`}
							onChange={(event) =>
								setNextStatus(event.target.value as LoomMigrationStatus)
							}
							value={nextStatus}
						>
							<option value="pending">Pending</option>
							<option value="in_progress">In progress</option>
							<option value="needs_information">Information needed</option>
							<option value="completed">Migration complete</option>
						</select>
					</div>
					<div>
						<label
							className="block text-sm text-gray-11"
							htmlFor={`loom-expected-${request.id}`}
						>
							Expected videos
						</label>
						<input
							className="mt-2 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-sm text-gray-12"
							id={`loom-expected-${request.id}`}
							min={0}
							onChange={(event) => setExpectedVideoCount(event.target.value)}
							type="number"
							value={expectedVideoCount}
						/>
					</div>
					<div>
						<label
							className="block text-sm text-gray-11"
							htmlFor={`loom-imported-${request.id}`}
						>
							Verified imported videos
						</label>
						<input
							className="mt-2 w-full rounded-lg border border-gray-6 bg-gray-1 px-3 py-2 text-sm text-gray-12"
							id={`loom-imported-${request.id}`}
							min={0}
							onChange={(event) => setImportedVideoCount(event.target.value)}
							type="number"
							value={importedVideoCount}
						/>
					</div>
				</div>
				<div>
					<label
						className="block text-sm text-gray-11"
						htmlFor={`loom-message-${request.id}`}
					>
						Message to customer{" "}
						{nextStatus === "needs_information" ? "(required)" : "(optional)"}
					</label>
					<textarea
						className="mt-2 min-h-24 w-full rounded-lg border border-gray-6 bg-gray-1 p-3 text-sm text-gray-12"
						id={`loom-message-${request.id}`}
						maxLength={2000}
						onChange={(event) => setMessage(event.target.value)}
						value={message}
					/>
				</div>
				{nextStatus === "completed" && (
					<label className="flex items-start gap-2 text-sm text-gray-11">
						<input
							checked={verified}
							className="mt-1"
							onChange={(event) => setVerified(event.target.checked)}
							type="checkbox"
						/>
						I checked terminal import results, the source and destination
						counts, and a playback and ownership sample.
					</label>
				)}
				<Button
					disabled={
						statusMutation.isPending ||
						importMutation.isPending ||
						fileMutation.isPending ||
						(nextStatus === "completed" && request.activeImportCount > 0)
					}
					size="sm"
					type="submit"
					variant="dark"
				>
					Save status
				</Button>
			</form>
		</div>
	);
}

export function LoomMigrationQueue() {
	const queueQuery = useQuery({
		queryKey: ["loom-migration-queue"],
		queryFn: getLoomMigrationOperatorQueue,
		refetchInterval: 20_000,
	});
	return (
		<div className="flex w-full max-w-5xl flex-col gap-5">
			<div>
				<h1 className="text-2xl font-medium text-gray-12">
					Loom migration queue
				</h1>
				<p className="mt-2 text-sm text-gray-10">
					Process Cap Pro concierge requests, reconcile every import, and update
					customers here.
				</p>
			</div>
			{queueQuery.isPending && (
				<p className="flex items-center gap-2 text-sm text-gray-10">
					<LoaderCircle className="size-4 animate-spin" /> Loading requests…
				</p>
			)}
			{queueQuery.isError && (
				<div className="rounded-lg border border-red-7 bg-red-3 p-4 text-sm text-red-11">
					Could not load the queue. {queueQuery.error.message}
					<button
						className="ml-2 underline"
						onClick={() => queueQuery.refetch()}
						type="button"
					>
						Try again
					</button>
				</div>
			)}
			{queueQuery.data?.length === 0 && (
				<p className="rounded-xl border border-gray-4 bg-gray-1 p-5 text-sm text-gray-10">
					No active Loom migration requests.
				</p>
			)}
			{queueQuery.data?.map((request) => (
				<QueueItem key={request.id} request={request} />
			))}
		</div>
	);
}
