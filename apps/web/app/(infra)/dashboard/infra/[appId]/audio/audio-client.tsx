"use client";

import clsx from "clsx";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import {
	type DragEvent,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import {
	type AudioTranscriptRow,
	createAudioTranscriptUpload,
	deleteAudioTranscript,
	listAudioTranscripts,
	readAudioTranscript,
	startAudioTranscript,
} from "@/actions/developers/transcripts";
import { TRANSCRIPT_MAX_UPLOAD_BYTES } from "@/lib/developer-transcripts";
import { infraAppPath } from "@/lib/infra-routes";
import { formatCharge, formatDuration } from "@/lib/infra-usage";
import { CopyButton, CopyTextButton } from "../../_components/copy";
import { ConfirmDialog } from "../../_components/dialog";
import {
	Block,
	Button,
	Empty,
	FOCUS,
	LIT,
	MONO,
	PageHeader,
	TD,
	TEXT_LINK,
	TH,
	TR,
} from "../../_components/ui";

const POLL_INTERVAL_MS = 2500;

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const STATUS_LABELS: Record<AudioTranscriptRow["status"], string> = {
	uploading: "Waiting for file",
	queued: "Queued",
	processing: "Transcribing",
	complete: "Complete",
	error: "Failed",
};

type ActiveUpload = { id: string; name: string; percent: number };

function putFile(
	url: string,
	file: File,
	onProgress: (percent: number) => void,
) {
	return new Promise<void>((resolve, reject) => {
		const request = new XMLHttpRequest();
		request.open("PUT", url);
		request.upload.onprogress = (event) => {
			if (event.lengthComputable && event.total > 0) {
				onProgress(Math.round((event.loaded / event.total) * 100));
			}
		};
		request.onload = () =>
			request.status >= 200 && request.status < 300
				? resolve()
				: reject(new Error(`Upload failed with status ${request.status}`));
		request.onerror = () => reject(new Error("Upload failed"));
		request.onabort = () => reject(new Error("Upload was cancelled"));
		request.send(file);
	});
}

const isPending = (row: AudioTranscriptRow) =>
	row.status === "queued" || row.status === "processing";

export function AudioClient({
	appId,
	initialTranscripts,
	available,
	canTranscribe,
	pricePerHour,
}: {
	appId: string;
	initialTranscripts: AudioTranscriptRow[];
	available: boolean;
	canTranscribe: boolean;
	pricePerHour: string;
}) {
	const inputId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [transcripts, setTranscripts] = useState(initialTranscripts);
	const [upload, setUpload] = useState<ActiveUpload | null>(null);
	const [dragging, setDragging] = useState(false);
	const [reader, setReader] = useState<{
		id: string;
		name: string;
		text: string;
	} | null>(null);
	const [opening, setOpening] = useState<string | null>(null);
	const [pendingDelete, setPendingDelete] = useState<AudioTranscriptRow | null>(
		null,
	);
	const [deleting, setDeleting] = useState(false);

	const refresh = useCallback(async () => {
		const result = await listAudioTranscripts(appId);
		if (result.ok) setTranscripts(result.transcripts);
	}, [appId]);

	const hasPending = transcripts.some(isPending);
	useEffect(() => {
		if (!hasPending) return;
		const timer = setInterval(() => {
			void refresh();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [hasPending, refresh]);

	const transcribe = async (file: File) => {
		if (upload) return;
		if (!canTranscribe) {
			toast.error("Add credits before transcribing");
			return;
		}
		if (file.size === 0) {
			toast.error("That file is empty");
			return;
		}
		if (file.size > TRANSCRIPT_MAX_UPLOAD_BYTES) {
			toast.error("Files can be up to 2 GB");
			return;
		}

		const created = await createAudioTranscriptUpload(appId, {
			fileName: file.name,
			contentLength: file.size,
		});
		if (!created.ok) {
			toast.error(created.message);
			return;
		}

		setUpload({ id: created.transcript.id, name: file.name, percent: 0 });
		try {
			await putFile(created.upload.url, file, (percent) =>
				setUpload((current) => (current ? { ...current, percent } : current)),
			);
			const started = await startAudioTranscript(appId, created.transcript.id);
			if (!started.ok) {
				toast.error(started.message);
				await deleteAudioTranscript(appId, created.transcript.id);
			}
		} catch {
			toast.error("The upload did not finish");
			await deleteAudioTranscript(appId, created.transcript.id);
		} finally {
			setUpload(null);
			await refresh();
		}
	};

	const onDrop = (event: DragEvent<HTMLButtonElement>) => {
		event.preventDefault();
		setDragging(false);
		const file = event.dataTransfer.files?.[0];
		if (file) void transcribe(file);
	};

	const open = async (row: AudioTranscriptRow) => {
		setOpening(row.id);
		const result = await readAudioTranscript(appId, row.id);
		setOpening(null);
		if (!result.ok) {
			toast.error(result.message);
			return;
		}
		setReader({ id: row.id, name: row.name, text: result.text });
	};

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		const result = await deleteAudioTranscript(appId, pendingDelete.id);
		setDeleting(false);
		if (!result.ok) {
			toast.error("Could not delete the transcript");
			return;
		}
		if (reader?.id === pendingDelete.id) setReader(null);
		setPendingDelete(null);
		toast.success("Transcript deleted");
		await refresh();
	};

	const rows = transcripts.filter((row) => row.id !== upload?.id);

	if (!available) {
		return (
			<>
				<PageHeader
					title="Audio"
					description={`Turn audio or video into text. ${pricePerHour} per audio hour, billed by the second from your credits.`}
				/>
				<div className="border-t border-[rgba(222,230,246,0.08)]">
					<Empty>Transcripts could not be loaded. Try again shortly.</Empty>
				</div>
			</>
		);
	}

	return (
		<>
			<PageHeader
				title="Audio"
				description={`Turn audio or video into text. ${pricePerHour} per audio hour, billed by the second from your credits.`}
				action={
					<Button
						onClick={() => inputRef.current?.click()}
						disabled={!canTranscribe}
						loading={upload !== null}
					>
						Choose a file
					</Button>
				}
			/>

			<input
				ref={inputRef}
				id={inputId}
				type="file"
				accept="audio/*,video/*"
				className="sr-only"
				aria-label="Audio or video file to transcribe"
				tabIndex={-1}
				onChange={(event) => {
					const file = event.target.files?.[0];
					event.target.value = "";
					if (file) void transcribe(file);
				}}
			/>

			{upload ? (
				<div className="border-y border-[rgba(222,230,246,0.08)] py-7">
					<div className="flex items-baseline justify-between gap-6">
						<p className="m-0 min-w-0 truncate text-[14px] text-[#E8ECF4]">
							Uploading {upload.name}
						</p>
						<p
							className={clsx(
								MONO,
								"m-0 text-[13px] tabular-nums text-[rgba(232,236,244,0.72)]",
							)}
						>
							{upload.percent}%
						</p>
					</div>
					<div
						role="progressbar"
						aria-label={`Uploading ${upload.name}`}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={upload.percent}
						className="mt-4 h-px w-full bg-[rgba(222,230,246,0.12)]"
					>
						<div
							className={clsx("h-px transition-[width] duration-200", LIT)}
							style={{ width: `${upload.percent}%` }}
						/>
					</div>
				</div>
			) : canTranscribe ? (
				<button
					type="button"
					onClick={() => inputRef.current?.click()}
					onDragOver={(event) => {
						event.preventDefault();
						setDragging(true);
					}}
					onDragLeave={() => setDragging(false)}
					onDrop={onDrop}
					className={clsx(
						"block w-full border-x-0 border-y bg-transparent px-0 py-7 text-left text-[14px] leading-[1.55] transition-colors duration-200",
						FOCUS,
						dragging
							? "border-[rgba(232,236,244,0.5)] bg-[rgba(222,230,246,0.03)] text-[#E8ECF4]"
							: "border-[rgba(222,230,246,0.08)] text-[rgba(232,236,244,0.58)] hover:text-[#E8ECF4]",
					)}
				>
					{dragging
						? "Drop the file to transcribe it."
						: "Drop an audio or video file here, up to 2 GB."}
				</button>
			) : (
				<p className="m-0 border-y border-[rgba(222,230,246,0.08)] py-7 text-[14px] leading-[1.55] text-[rgba(232,236,244,0.58)]">
					This app needs credits before it can transcribe.{" "}
					<Link
						href={infraAppPath(appId, "billing")}
						className={clsx(TEXT_LINK, "text-[#E8ECF4]")}
					>
						Add credits
					</Link>
				</p>
			)}

			{reader && (
				<Block
					title={reader.name}
					action={
						<div className="flex items-center gap-2">
							<CopyTextButton value={reader.text} label="Copy text" />
							<Button variant="quiet" size="sm" onClick={() => setReader(null)}>
								Close
							</Button>
						</div>
					}
				>
					<p className="m-0 max-h-[60vh] max-w-[720px] overflow-y-auto whitespace-pre-wrap py-6 text-[14.5px] leading-[1.7] text-[rgba(232,236,244,0.86)]">
						{reader.text || "No speech was found."}
					</p>
				</Block>
			)}

			{rows.length === 0 ? (
				!upload && (
					<Empty>
						No transcripts yet. Files you transcribe here or through the API
						show up in this list.
					</Empty>
				)
			) : (
				<div className="relative overflow-x-auto">
					<table className="w-full border-collapse">
						<thead>
							<tr className={TR}>
								<th className={TH}>Name</th>
								<th className={clsx(TH, "text-right")}>Duration</th>
								<th className={TH}>Status</th>
								<th className={clsx(TH, "text-right")}>Cost</th>
								<th className={TH}>Created</th>
								<th className={TH}>Transcript id</th>
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{rows.map((row) => (
								<tr
									key={row.id}
									className={clsx(
										TR,
										"transition-colors duration-150 hover:bg-[rgba(222,230,246,0.025)]",
									)}
								>
									<td className={clsx(TD, "max-w-[17rem] text-[#E8ECF4]")}>
										{row.status === "complete" ? (
											<button
												type="button"
												onClick={() => void open(row)}
												disabled={opening === row.id}
												className={clsx(
													"block max-w-full truncate rounded-[4px] text-left transition-colors duration-200 hover:text-white hover:underline",
													FOCUS,
												)}
												title={`Read ${row.name}`}
											>
												{row.name}
											</button>
										) : (
											<span className="block truncate">{row.name}</span>
										)}
										{row.errorMessage && (
											<span className="block truncate text-[12.5px] text-[rgba(232,236,244,0.42)]">
												{row.errorMessage}
											</span>
										)}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"text-right text-[13px] tabular-nums",
										)}
									>
										{formatDuration(row.durationSeconds) ?? "pending"}
									</td>
									<td
										className={clsx(
											TD,
											row.status === "error" && "text-[#F2A199]",
											row.status === "complete" && "text-[#E8ECF4]",
										)}
									>
										{STATUS_LABELS[row.status]}
									</td>
									<td
										className={clsx(
											TD,
											MONO,
											"text-right text-[13px] tabular-nums",
										)}
									>
										{row.status === "complete"
											? formatCharge(row.costMicroCredits)
											: row.status === "error"
												? formatCharge(0)
												: "pending"}
									</td>
									<td className={TD}>
										{dateFormat.format(new Date(row.createdAt))}
									</td>
									<td className={clsx(TD, "py-1.5")}>
										<span
											className={clsx(
												MONO,
												"inline-flex items-center gap-1 text-[13px]",
											)}
										>
											{row.id}
											<CopyButton value={row.id} label="Copy transcript id" />
										</span>
									</td>
									<td className={clsx(TD, "py-1.5 text-right")}>
										<button
											type="button"
											onClick={() => setPendingDelete(row)}
											aria-label={`Delete ${row.name}`}
											className={clsx(
												"inline-flex size-7 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.4)] transition-colors duration-200 hover:bg-[rgba(242,161,153,0.1)] hover:text-[#F2A199]",
												FOCUS,
											)}
										>
											<Trash2 size={14} />
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title="Delete transcript"
				description={
					pendingDelete
						? `Delete "${pendingDelete.name}"? The text is removed and disappears from the API.`
						: undefined
				}
				confirmLabel="Delete"
				loading={deleting}
				onConfirm={() => void confirmDelete()}
				onCancel={() => {
					if (!deleting) setPendingDelete(null);
				}}
			/>
		</>
	);
}
