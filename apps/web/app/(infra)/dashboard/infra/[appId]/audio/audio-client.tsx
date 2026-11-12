"use client";

import clsx from "clsx";
import { Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
import {
	INFRA_TRANSCRIPT_LABELS,
	infraTranscriptDisplayState,
} from "@/lib/infra-transcript-view";
import {
	EMPTY_FILE_MESSAGE,
	isDefinitiveRejection,
	retryAfterMs,
} from "@/lib/infra-upload";
import { formatCharge, formatDuration } from "@/lib/infra-usage";
import type { InfraLocalUpload } from "@/lib/infra-video-view";
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
import { usePageWork } from "../../_components/uploads";

const POLL_INTERVAL_MS = 2500;
const PAGE_STEP = 50;
const PUT_ATTEMPTS = 3;
const START_ATTEMPTS = 3;
const RATE_LIMIT_ATTEMPTS = 6;
const CANCELLED = "Upload cancelled";
const NEEDS_CREDITS = "insufficient_credits";
const LEAVE_DURING_UPLOAD =
	"A file is still uploading. Leaving now cancels it.";
const NO_SENT_UPLOADS: ReadonlySet<string> = new Set();

const dateFormat = new Intl.DateTimeFormat("en-US", {
	month: "short",
	day: "numeric",
	year: "numeric",
	timeZone: "UTC",
});

const NONE = <span className="text-[rgba(232,236,244,0.3)]">none</span>;

class UploadError extends Error {
	constructor(
		message: string,
		readonly status = 0,
		readonly code = "",
		readonly retryAfter: string | null = null,
	) {
		super(message);
	}
}

type Upload =
	| { phase: "idle" }
	| {
			phase: "working";
			name: string;
			progress: number;
			label: string;
			locked: boolean;
	  }
	| { phase: "failed"; message: string; needsCredits: boolean };

function pause(ms: number, signal: AbortSignal) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new UploadError(CANCELLED));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			reject(new UploadError(CANCELLED));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function putFile(
	url: string,
	file: File,
	onProgress: (loaded: number) => void,
	signal: AbortSignal,
) {
	return new Promise<void>((resolve, reject) => {
		if (signal.aborted) {
			reject(new UploadError(CANCELLED));
			return;
		}
		const xhr = new XMLHttpRequest();
		const abort = () => xhr.abort();
		signal.addEventListener("abort", abort, { once: true });
		xhr.upload.onprogress = (event) => onProgress(event.loaded);
		xhr.onload = () => {
			signal.removeEventListener("abort", abort);
			if (xhr.status >= 200 && xhr.status < 300) resolve();
			else {
				reject(
					new UploadError(
						"Storage did not accept the file",
						xhr.status,
						"",
						xhr.getResponseHeader("Retry-After"),
					),
				);
			}
		};
		xhr.onerror = () => {
			signal.removeEventListener("abort", abort);
			reject(
				new UploadError(
					"The file could not reach storage. Check your connection and try again.",
				),
			);
		};
		xhr.onabort = () => reject(new UploadError(CANCELLED));
		xhr.open("PUT", url);
		xhr.send(file);
	});
}

const isPending = (row: AudioTranscriptRow) =>
	row.status === "queued" || row.status === "processing";

export function AudioClient({
	appId,
	initialTranscripts,
	initialHasMore,
	available,
	canTranscribe,
	creditNeeded,
	creditBalance,
	pricePerHour,
}: {
	appId: string;
	initialTranscripts: AudioTranscriptRow[];
	initialHasMore: boolean;
	available: boolean;
	canTranscribe: boolean;
	creditNeeded: string;
	creditBalance: string;
	pricePerHour: string;
}) {
	const input = useRef<HTMLInputElement>(null);
	const controller = useRef<AbortController | null>(null);
	const [transcripts, setTranscripts] = useState(initialTranscripts);
	const [hasMore, setHasMore] = useState(initialHasMore);
	const [loadingMore, setLoadingMore] = useState(false);
	const pageSize = useRef(Math.max(PAGE_STEP, initialTranscripts.length));
	const [upload, setUpload] = useState<Upload>({ phase: "idle" });
	const [sendingId, setSendingId] = useState<string | null>(null);
	const [sentIds, setSentIds] = useState(NO_SENT_UPLOADS);
	const [over, setOver] = useState(false);
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

	useEffect(() => () => controller.current?.abort(), []);
	usePageWork(upload.phase === "working" ? LEAVE_DURING_UPLOAD : null);

	const localUpload = (id: string): InfraLocalUpload =>
		sentIds.has(id) ? "sent" : id === sendingId ? "sending" : null;

	const refresh = useCallback(async () => {
		const result = await listAudioTranscripts(appId, pageSize.current).catch(
			() => null,
		);
		if (result?.ok) {
			setTranscripts(result.transcripts);
			setHasMore(result.hasMore);
		}
	}, [appId]);

	const showMore = async () => {
		setLoadingMore(true);
		pageSize.current += PAGE_STEP;
		await refresh();
		setLoadingMore(false);
	};

	const hasPending = transcripts.some(isPending);
	useEffect(() => {
		if (!hasPending) return;
		const timer = setInterval(() => {
			void refresh();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [hasPending, refresh]);

	const start = async (file: File) => {
		if (upload.phase === "working") return;
		if (file.size === 0) {
			setUpload({
				phase: "failed",
				needsCredits: false,
				message: EMPTY_FILE_MESSAGE,
			});
			return;
		}
		if (file.size > TRANSCRIPT_MAX_UPLOAD_BYTES) {
			setUpload({
				phase: "failed",
				needsCredits: false,
				message: "Files can be up to 2 GB.",
			});
			return;
		}

		const abort = new AbortController();
		const { signal } = abort;
		controller.current = abort;
		const show = (progress: number, label: string, locked = false) =>
			setUpload({ phase: "working", name: file.name, progress, label, locked });
		const stopIfCancelled = () => {
			if (signal.aborted) throw new UploadError(CANCELLED);
		};
		let transcriptId: string | null = null;
		let outcome: "open" | "unconfirmed" | "done" = "open";

		try {
			show(0, "Starting");
			const created = await createAudioTranscriptUpload(appId, {
				fileName: file.name,
				contentLength: file.size,
			});
			if (!created.ok) {
				throw new UploadError(created.message, 400, created.code);
			}
			transcriptId = created.transcript.id;
			setSendingId(transcriptId);
			stopIfCancelled();

			for (let attempt = 1, limited = 0; ; ) {
				try {
					await putFile(
						created.upload.url,
						file,
						(loaded) => show(loaded / Math.max(1, file.size), "Uploading"),
						signal,
					);
					break;
				} catch (error) {
					if (signal.aborted || !(error instanceof UploadError)) throw error;
					if (error.status === 429 && limited < RATE_LIMIT_ATTEMPTS) {
						limited++;
						await pause(retryAfterMs(error.retryAfter), signal);
						continue;
					}
					if (attempt >= PUT_ATTEMPTS || isDefinitiveRejection(error.status)) {
						throw error;
					}
					await pause(1000 * attempt, signal);
					attempt++;
				}
			}

			stopIfCancelled();
			show(1, "Finishing", true);
			outcome = "unconfirmed";
			for (let attempt = 1; outcome !== "done"; attempt++) {
				try {
					const started = await startAudioTranscript(appId, transcriptId);
					if (!started.ok) {
						outcome = "open";
						throw new UploadError(started.message, 400, started.code);
					}
					outcome = "done";
				} catch (error) {
					if (outcome === "open" || attempt >= START_ATTEMPTS) throw error;
					await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
				}
			}
			const sentId = transcriptId;
			setSentIds((sent) => new Set(sent).add(sentId));
			setSendingId(null);
			setUpload({ phase: "idle" });
			toast.success(`Transcribing ${file.name}`);
			await refresh();
		} catch (error) {
			if (outcome === "unconfirmed") {
				setUpload({
					phase: "failed",
					needsCredits: false,
					message:
						"The file is uploaded but the server has not confirmed it. Check the list below before trying again.",
				});
				await refresh();
				return;
			}
			if (transcriptId) {
				await deleteAudioTranscript(appId, transcriptId).catch(() => {});
			}
			if (signal.aborted) {
				setUpload({ phase: "idle" });
				await refresh();
				return;
			}
			const needsCredits =
				error instanceof UploadError && error.code === NEEDS_CREDITS;
			setUpload({
				phase: "failed",
				needsCredits,
				message: needsCredits
					? "This app needs credits before it can transcribe."
					: error instanceof Error
						? error.message
						: "The upload failed",
			});
			await refresh();
		} finally {
			setSendingId((current) => (current === transcriptId ? null : current));
			if (controller.current === abort) controller.current = null;
		}
	};

	const pick = (files: FileList | null) => {
		const file = files?.[0];
		if (file) void start(file);
	};

	const open = async (row: AudioTranscriptRow) => {
		setOpening(row.id);
		const result = await readAudioTranscript(appId, row.id).catch(() => null);
		setOpening(null);
		if (!result?.ok) {
			toast.error(result?.message ?? "Could not open the transcript");
			return;
		}
		setReader({ id: row.id, name: row.name, text: result.text });
	};

	const confirmDelete = async () => {
		if (!pendingDelete) return;
		setDeleting(true);
		const result = await deleteAudioTranscript(appId, pendingDelete.id).catch(
			() => null,
		);
		setDeleting(false);
		if (!result?.ok) {
			toast.error("Could not delete the transcript");
			return;
		}
		if (reader?.id === pendingDelete.id) setReader(null);
		setPendingDelete(null);
		toast.success(
			pendingDeleteUnfinished ? "Upload removed" : "Transcript deleted",
		);
		await refresh();
	};

	const pendingDeleteUnfinished =
		pendingDelete !== null &&
		infraTranscriptDisplayState(
			pendingDelete.status,
			localUpload(pendingDelete.id),
		) === "unfinished";

	const description = `Audio or video to text. ${pricePerHour} per audio hour, billed by the second.`;

	if (!available) {
		return (
			<>
				<PageHeader title="Audio" description={description} />
				<div className="border-t border-[rgba(222,230,246,0.08)]">
					<Empty>Transcripts could not be loaded. Try again shortly.</Empty>
				</div>
			</>
		);
	}

	const working = upload.phase === "working";

	return (
		<>
			<PageHeader title="Audio" description={description} />

			<section
				aria-label="Transcribe a file"
				onDragOver={(e) => {
					e.preventDefault();
					if (!working) setOver(true);
				}}
				onDragLeave={() => setOver(false)}
				onDrop={(e) => {
					e.preventDefault();
					setOver(false);
					if (!working) pick(e.dataTransfer.files);
				}}
				className={clsx(
					"relative overflow-hidden rounded-[12px] px-5 py-5 transition-[background-color,box-shadow] duration-200",
					over
						? "bg-[rgba(222,230,246,0.05)] shadow-[inset_0_0_0_1px_rgba(232,236,244,0.7)]"
						: "shadow-[inset_0_0_0_1px_rgba(222,230,246,0.12)]",
				)}
			>
				<input
					ref={input}
					type="file"
					accept="audio/*,video/*,.mkv"
					className="sr-only"
					tabIndex={-1}
					aria-hidden="true"
					onChange={(e) => {
						pick(e.target.files);
						e.target.value = "";
					}}
				/>
				{working ? (
					<div className="flex items-center justify-between gap-5">
						<div className="min-w-0">
							<p className="m-0 truncate text-[14px] leading-[1.4] text-[#E8ECF4]">
								{upload.name}
							</p>
							<p
								aria-live="polite"
								className="m-0 mt-1 text-[13px] leading-[1.4] text-[rgba(232,236,244,0.5)]"
							>
								{upload.label}
							</p>
						</div>
						<div className="flex shrink-0 items-center gap-4">
							<span
								className={clsx(
									MONO,
									"text-[14px] tabular-nums tracking-[-0.02em] text-white",
								)}
							>
								{Math.round(upload.progress * 100)}%
							</span>
							<Button
								variant="quiet"
								size="sm"
								disabled={upload.locked}
								onClick={() => controller.current?.abort()}
							>
								Cancel
							</Button>
						</div>
						<span
							aria-hidden="true"
							className="absolute inset-x-0 bottom-0 h-px bg-[rgba(222,230,246,0.1)]"
						/>
						<span
							aria-hidden="true"
							style={{ width: `${Math.max(1, upload.progress * 100)}%` }}
							className={clsx(
								"absolute bottom-0 left-0 h-[2px] rounded-full transition-[width] duration-300 ease-out",
								LIT,
							)}
						/>
					</div>
				) : (
					<div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
						<div className="min-w-0">
							<p className="m-0 text-[14px] leading-[1.4] text-[#E8ECF4]">
								{over
									? "Drop it to transcribe"
									: "Drop an audio or video file here to transcribe it"}
							</p>
							{upload.phase === "failed" ? (
								<p
									role="alert"
									className="m-0 mt-1 text-pretty text-[13px] leading-[1.5] text-[#F2A199]"
								>
									{upload.message}{" "}
									{upload.needsCredits && (
										<Link
											href={infraAppPath(appId, "billing")}
											className={clsx(TEXT_LINK, "text-[#E8ECF4]")}
										>
											Add credits
										</Link>
									)}
								</p>
							) : canTranscribe ? (
								<p className="m-0 mt-1 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
									Up to 2 GB and 4 hours of audio.
								</p>
							) : (
								<p className="m-0 mt-1 text-pretty text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
									Transcribing needs {creditNeeded} of credit and this app has{" "}
									{creditBalance}.{" "}
									<Link
										href={infraAppPath(appId, "billing")}
										className={clsx(TEXT_LINK, "text-[#E8ECF4]")}
									>
										Add credits
									</Link>
								</p>
							)}
						</div>
						<Button
							variant="ghost"
							size="sm"
							onClick={() => input.current?.click()}
						>
							Choose a file
						</Button>
					</div>
				)}
			</section>

			{reader && (
				<Block
					title={reader.name}
					action={
						<div className="flex items-center gap-2">
							{reader.text && (
								<CopyTextButton value={reader.text} label="Copy text" />
							)}
							<Button variant="quiet" size="sm" onClick={() => setReader(null)}>
								Close
							</Button>
						</div>
					}
				>
					{reader.text ? (
						<p className="m-0 max-h-[60vh] max-w-[720px] overflow-y-auto whitespace-pre-wrap py-6 text-[14.5px] leading-[1.7] text-[rgba(232,236,244,0.86)]">
							{reader.text}
						</p>
					) : (
						<Empty>
							No speech was found in this file, so the transcript is empty. It
							was billed for its audio length.
						</Empty>
					)}
				</Block>
			)}

			{transcripts.length === 0 ? (
				<div className="border-t border-[rgba(222,230,246,0.08)]">
					<Empty>
						No transcripts yet. Files you transcribe here or through the API
						show up in this list.
					</Empty>
				</div>
			) : (
				<div className="relative -mx-1 overflow-x-auto px-1">
					<table className="w-full border-collapse border-t border-[rgba(222,230,246,0.08)]">
						<thead>
							<tr className={TR}>
								<th className={TH}>Name</th>
								<th className={clsx(TH, "hidden text-right sm:table-cell")}>
									Duration
								</th>
								<th className={clsx(TH, "hidden sm:table-cell")}>Status</th>
								<th className={clsx(TH, "text-right")}>Cost</th>
								<th className={clsx(TH, "hidden md:table-cell")}>Created</th>
								<th className={clsx(TH, "hidden xl:table-cell")}>
									Transcript id
								</th>
								<th className={TH}>
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{transcripts.map((row) => {
								const state = infraTranscriptDisplayState(
									row.status,
									localUpload(row.id),
								);
								const unfinished = state === "unfinished";
								const note = unfinished
									? "The file has not arrived. If the upload was interrupted, remove this and upload it again."
									: (row.errorMessage ??
										(row.noSpeech ? "No speech found" : null));
								const status = (
									<span
										className={clsx(
											"whitespace-nowrap",
											state === "error" && "text-[#F2A199]",
											state === "complete" && "text-[#E8ECF4]",
										)}
									>
										{INFRA_TRANSCRIPT_LABELS[state]}
									</span>
								);
								return (
									<tr
										key={row.id}
										className={clsx(
											TR,
											"transition-colors duration-150 hover:bg-[rgba(222,230,246,0.025)]",
										)}
									>
										<td className="w-full max-w-0 py-3 pr-6 align-baseline text-[13.5px] text-[#E8ECF4]">
											{state === "complete" ? (
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
											<span className="mt-1 block text-[12.5px] text-[rgba(232,236,244,0.72)] sm:hidden">
												{status}
											</span>
											{note && (
												<span className="mt-0.5 block text-pretty text-[12.5px] leading-[1.4] text-[rgba(232,236,244,0.46)]">
													{note}
												</span>
											)}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"hidden text-right align-baseline text-[13px] tabular-nums sm:table-cell",
											)}
										>
											{formatDuration(row.durationSeconds) ??
												(state === "error" || unfinished ? NONE : "pending")}
										</td>
										<td
											className={clsx(
												TD,
												"hidden align-baseline sm:table-cell",
											)}
										>
											{status}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"text-right align-baseline text-[13px] tabular-nums",
											)}
										>
											{state === "complete"
												? formatCharge(row.costMicroCredits)
												: state === "error" || unfinished
													? formatCharge(0)
													: "pending"}
										</td>
										<td
											className={clsx(
												TD,
												"hidden align-baseline md:table-cell",
											)}
										>
											{dateFormat.format(new Date(row.createdAt))}
										</td>
										<td
											className={clsx(
												TD,
												MONO,
												"hidden align-baseline text-[13px] xl:table-cell",
											)}
										>
											{row.id}
										</td>
										<td className={clsx(TD, "py-1.5 text-right align-top")}>
											<span className="inline-flex items-center gap-0.5">
												<CopyButton value={row.id} label="Copy transcript id" />
												<button
													type="button"
													onClick={() => setPendingDelete(row)}
													disabled={state === "uploading"}
													aria-label={`${unfinished ? "Remove" : "Delete"} ${row.name}`}
													title={unfinished ? "Remove" : "Delete"}
													className={clsx(
														"inline-flex size-7 items-center justify-center rounded-[6px] text-[rgba(232,236,244,0.4)] transition-colors duration-200 hover:bg-[rgba(242,161,153,0.1)] hover:text-[#F2A199] disabled:pointer-events-none disabled:opacity-40",
														FOCUS,
													)}
												>
													<Trash2 size={14} />
												</button>
											</span>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}

			{hasMore && (
				<div>
					<Button
						variant="ghost"
						size="sm"
						loading={loadingMore}
						onClick={() => void showMore()}
					>
						Show more
					</Button>
				</div>
			)}

			<ConfirmDialog
				open={pendingDelete !== null}
				title={pendingDeleteUnfinished ? "Remove upload" : "Delete transcript"}
				description={
					pendingDelete
						? pendingDeleteUnfinished
							? `Remove "${pendingDelete.name}"? Its file has not arrived. An upload still running somewhere else will fail.`
							: `Delete "${pendingDelete.name}"? The text is removed and disappears from the API.`
						: undefined
				}
				confirmLabel={pendingDeleteUnfinished ? "Remove" : "Delete"}
				loading={deleting}
				onConfirm={() => void confirmDelete()}
				onCancel={() => {
					if (!deleting) setPendingDelete(null);
				}}
			/>
		</>
	);
}
