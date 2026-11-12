"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import { infraAppPath } from "@/lib/infra-routes";
import {
	isDefinitiveRejection,
	partBytesFor,
	retryAfterMs,
} from "@/lib/infra-upload";
import { Button, LIT, MONO, TEXT_LINK } from "./ui";

const PART_ATTEMPTS = 3;
const COMPLETE_ATTEMPTS = 3;
const RATE_LIMIT_ATTEMPTS = 6;
const SDK = "/api/developer/sdk/v1";

class UploadError extends Error {
	constructor(
		message: string,
		readonly status = 0,
	) {
		super(message);
	}
}

const CANCELLED = "Upload cancelled";

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

async function call<T>(
	path: string,
	publicKey: string,
	body: unknown,
	signal?: AbortSignal,
	cancellable = true,
) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${SDK}${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${publicKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: cancellable ? signal : undefined,
		});
		if (res.status === 429 && signal && attempt < RATE_LIMIT_ATTEMPTS) {
			await pause(retryAfterMs(res.headers.get("Retry-After")), signal);
			continue;
		}
		const data = (await res.json().catch(() => ({}))) as T & {
			error?: string;
			message?: string;
		};
		if (!res.ok) {
			throw new UploadError(
				data.message ?? data.error ?? "The upload could not be started",
				res.status,
			);
		}
		return data;
	}
}

function readVideo(file: File) {
	return new Promise<{ duration: number; width: number; height: number }>(
		(resolve, reject) => {
			const url = URL.createObjectURL(file);
			const video = document.createElement("video");
			const done = () => {
				video.onloadedmetadata = null;
				video.onerror = null;
				video.removeAttribute("src");
				video.load();
				URL.revokeObjectURL(url);
			};
			video.preload = "metadata";
			video.muted = true;
			video.onloadedmetadata = () => {
				const { duration, videoWidth, videoHeight } = video;
				done();
				if (!Number.isFinite(duration) || duration <= 0) {
					reject(
						new UploadError(
							"This browser cannot read the length of that file. Upload it through the API instead.",
						),
					);
					return;
				}
				if (!videoWidth || !videoHeight) {
					reject(new UploadError("That file has no video in it."));
					return;
				}
				resolve({ duration, width: videoWidth, height: videoHeight });
			};
			video.onerror = () => {
				done();
				reject(
					new UploadError(
						"This browser cannot open that file. MP4, MOV and WebM work best, or upload it through the API.",
					),
				);
			};
			video.src = url;
		},
	);
}

function putPart(
	url: string,
	part: Blob,
	onProgress: (loaded: number) => void,
	signal: AbortSignal,
) {
	return new Promise<string>((resolve, reject) => {
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
			const etag = xhr.getResponseHeader("ETag");
			if (xhr.status >= 200 && xhr.status < 300 && etag) resolve(etag);
			else reject(new UploadError("A part of the file failed to upload"));
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
		xhr.send(part);
	});
}

export function UploadDrop({
	appId,
	publicKey,
}: {
	appId: string;
	publicKey: string;
}) {
	const router = useRouter();
	const input = useRef<HTMLInputElement>(null);
	const controller = useRef<AbortController | null>(null);
	const [upload, setUpload] = useState<Upload>({ phase: "idle" });
	const [over, setOver] = useState(false);

	useEffect(() => () => controller.current?.abort(), []);

	const start = async (file: File) => {
		if (upload.phase === "working") return;
		const abort = new AbortController();
		const { signal } = abort;
		controller.current = abort;
		const name = file.name.replace(/\.[^.]+$/, "") || "Untitled";
		const show = (progress: number, label: string, locked = false) =>
			setUpload({ phase: "working", name: file.name, progress, label, locked });
		const stopIfCancelled = () => {
			if (signal.aborted) throw new UploadError(CANCELLED);
		};
		let videoId: string | null = null;
		let uploadId: string | null = null;
		let outcome: "open" | "unconfirmed" | "done" = "open";

		try {
			show(0, "Reading the file");
			const meta = await readVideo(file);
			stopIfCancelled();
			const created = await call<{ videoId: string }>(
				"/videos/create",
				publicKey,
				{ name: name.slice(0, 255) },
				signal,
				false,
			);
			videoId = created.videoId;
			stopIfCancelled();
			const initiated = await call<{ uploadId: string }>(
				"/upload/multipart/initiate",
				publicKey,
				{ videoId, contentType: file.type || "video/mp4" },
				signal,
				false,
			);
			uploadId = initiated.uploadId;
			stopIfCancelled();

			const partBytes = partBytesFor(file.size);
			const parts: { partNumber: number; etag: string; size: number }[] = [];
			const total = Math.max(1, Math.ceil(file.size / partBytes));
			for (let index = 0; index < total; index++) {
				const blob = file.slice(index * partBytes, (index + 1) * partBytes);
				const sent = index * partBytes;
				let etag: string | null = null;
				for (let attempt = 1; !etag; attempt++) {
					stopIfCancelled();
					try {
						const { presignedUrl } = await call<{ presignedUrl: string }>(
							"/upload/multipart/presign-part",
							publicKey,
							{ videoId, uploadId, partNumber: index + 1 },
							signal,
						);
						stopIfCancelled();
						etag = await putPart(
							presignedUrl,
							blob,
							(loaded) =>
								show((sent + loaded) / Math.max(1, file.size), "Uploading"),
							signal,
						);
					} catch (error) {
						if (signal.aborted || attempt >= PART_ATTEMPTS) throw error;
						await pause(1000 * attempt, signal);
					}
				}
				parts.push({ partNumber: index + 1, etag, size: blob.size });
			}

			stopIfCancelled();
			show(1, "Finishing", true);
			outcome = "unconfirmed";
			for (let attempt = 1; outcome !== "done"; attempt++) {
				try {
					await call("/upload/multipart/complete", publicKey, {
						videoId,
						uploadId,
						parts,
						durationInSecs: meta.duration,
						width: meta.width,
						height: meta.height,
					});
					outcome = "done";
				} catch (error) {
					const status = error instanceof UploadError ? error.status : 0;
					if (isDefinitiveRejection(status)) {
						outcome = "open";
						throw error;
					}
					if (attempt >= COMPLETE_ATTEMPTS) throw error;
					await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
				}
			}
			setUpload({ phase: "idle" });
			toast.success(`Uploaded ${file.name}`);
			router.refresh();
		} catch (error) {
			if (outcome === "unconfirmed") {
				setUpload({
					phase: "failed",
					needsCredits: false,
					message:
						"The file is uploaded but the server has not confirmed it. Check the list below before trying again.",
				});
				router.refresh();
				return;
			}
			if (videoId && uploadId) {
				await call("/upload/multipart/abort", publicKey, {
					videoId,
					uploadId,
				}).catch(() => {});
			}
			if (videoId) await deleteDeveloperVideo(appId, videoId).catch(() => {});
			if (signal.aborted) {
				setUpload({ phase: "idle" });
				return;
			}
			const status = error instanceof UploadError ? error.status : 0;
			setUpload({
				phase: "failed",
				needsCredits: status === 402,
				message:
					status === 402
						? "This app needs credits before it can take an upload."
						: error instanceof Error
							? error.message
							: "The upload failed",
			});
		} finally {
			if (controller.current === abort) controller.current = null;
		}
	};

	const pick = (files: FileList | null) => {
		const file = files?.[0];
		if (file) void start(file);
	};

	const working = upload.phase === "working";

	return (
		<section
			aria-label="Upload a video"
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
				accept="video/*,.mkv"
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
							{over ? "Drop it to upload" : "Drop a video here to upload it"}
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
						) : (
							<p className="m-0 mt-1 text-[13px] leading-[1.5] text-[rgba(232,236,244,0.5)]">
								MP4, MOV or WebM, billed at the upload rate.
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
	);
}
