"use client";

import { useRouter } from "next/navigation";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { deleteDeveloperVideo } from "@/actions/developers/delete-video";
import {
	COMPLETION_IN_PROGRESS,
	completeRetryPlan,
	EMPTY_FILE_MESSAGE,
	isDefinitiveRejection,
	partBytesFor,
	presignBatch,
	retryAfterMs,
	startsLikeAnImageOrDocument,
} from "@/lib/infra-upload";
import type { InfraLocalUpload } from "@/lib/infra-video-view";

const PART_ATTEMPTS = 3;
const COMPLETE_ATTEMPTS = 3;
const RATE_LIMIT_ATTEMPTS = 6;
const UPLOAD_API = "/api/developer/console/upload";
const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i;

class UploadError extends Error {
	constructor(
		message: string,
		readonly status = 0,
		readonly code: string | null = null,
	) {
		super(message);
	}
}

const CANCELLED = "Upload cancelled";
const NOT_A_VIDEO = "That is not a video. MP4, MOV and WebM work best.";

export type ActiveUpload = {
	name: string;
	progress: number;
	label: string;
	locked: boolean;
};

export type UploadFailure = {
	id: number;
	name: string;
	message: string;
	needsCredits: boolean;
	skipped: number;
};

type Uploads = {
	appId: string;
	active: ActiveUpload | null;
	waiting: number;
	failures: UploadFailure[];
	add: (files: readonly File[]) => void;
	cancel: () => void;
};

type LocalUploads = { sending: string | null; sent: ReadonlySet<string> };
type PageWork = {
	message: string | null;
	set: (message: string | null) => void;
};

const NO_LOCAL_UPLOADS: LocalUploads = { sending: null, sent: new Set() };

const UploadsContext = createContext<Uploads | null>(null);
const LocalUploadsContext = createContext<LocalUploads>(NO_LOCAL_UPLOADS);
const PageWorkContext = createContext<PageWork | null>(null);

export function useUploads() {
	const uploads = useContext(UploadsContext);
	if (!uploads) throw new Error("useUploads needs an UploadsProvider");
	return uploads;
}

export function useUploadingVideoId() {
	return useContext(LocalUploadsContext).sending;
}

export function useLocalUpload() {
	const { sending, sent } = useContext(LocalUploadsContext);
	return useCallback(
		(videoId: string): InfraLocalUpload =>
			sent.has(videoId) ? "sent" : videoId === sending ? "sending" : null,
		[sending, sent],
	);
}

export const LEAVE_DURING_UPLOAD =
	"A video is still uploading. Leaving now cancels it.";

function useWarnBeforeUnload(message: string | null) {
	useEffect(() => {
		if (!message) return;
		const warn = (event: BeforeUnloadEvent) => {
			event.preventDefault();
			event.returnValue = message;
		};
		window.addEventListener("beforeunload", warn);
		return () => window.removeEventListener("beforeunload", warn);
	}, [message]);
}

// Work that lives in one page, such as an Audio upload, stops when that page
// is left. The page names it here so the browser and the console's own links
// ask first.
export function usePageWork(message: string | null) {
	const set = useContext(PageWorkContext)?.set;
	useWarnBeforeUnload(message);
	useEffect(() => {
		if (!set || !message) return;
		set(message);
		return () => set(null);
	}, [set, message]);
}

export function useMayLeavePage() {
	const message = useContext(PageWorkContext)?.message ?? null;
	return useCallback(() => !message || window.confirm(message), [message]);
}

// Uploads keep running between pages of one app. Leaving the app, or the
// console, unmounts them, so those links ask first.
export function useMayLeave() {
	const uploading = useContext(UploadsContext)?.active != null;
	const pageWork = useContext(PageWorkContext)?.message ?? null;
	const message = pageWork ?? (uploading ? LEAVE_DURING_UPLOAD : null);
	return useCallback(() => !message || window.confirm(message), [message]);
}

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
	body: unknown,
	signal?: AbortSignal,
	cancellable = true,
) {
	for (let attempt = 1; ; attempt++) {
		const res = await fetch(`${UPLOAD_API}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
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
			code?: string;
		};
		if (!res.ok) {
			throw new UploadError(
				data.message ?? data.error ?? "The upload could not be started",
				res.status,
				typeof data.code === "string" ? data.code : null,
			);
		}
		return data;
	}
}

function readVideo(file: File) {
	return new Promise<{ duration: number; width: number; height: number }>(
		(resolve, reject) => {
			if (
				file.type &&
				!file.type.startsWith("video/") &&
				!VIDEO_FILE.test(file.name)
			) {
				reject(new UploadError(NOT_A_VIDEO));
				return;
			}
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
				void file
					.slice(0, 8)
					.arrayBuffer()
					.then((head) => startsLikeAnImageOrDocument(new Uint8Array(head)))
					.catch(() => false)
					.then((notVideo) =>
						reject(
							new UploadError(
								notVideo
									? NOT_A_VIDEO
									: "This browser cannot open that file. MP4, MOV and WebM work best, or upload it through the API.",
							),
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

type UploadOutcome =
	| { result: "done"; videoId: string }
	| { result: "cancelled" }
	| { result: "unconfirmed" }
	| { result: "failed"; message: string; needsCredits: boolean };

async function uploadFile(
	appId: string,
	file: File,
	signal: AbortSignal,
	report: (upload: ActiveUpload, videoId: string | null) => void,
): Promise<UploadOutcome> {
	const name = file.name.replace(/\.[^.]+$/, "") || "Untitled";
	let videoId: string | null = null;
	let uploadId: string | null = null;
	let outcome: "open" | "unconfirmed" | "done" = "open";
	const show = (progress: number, label: string, locked = false) =>
		report({ name: file.name, progress, label, locked }, videoId);
	const stopIfCancelled = () => {
		if (signal.aborted) throw new UploadError(CANCELLED);
	};

	try {
		if (file.size === 0) throw new UploadError(EMPTY_FILE_MESSAGE);
		show(0, "Reading the file");
		const meta = await readVideo(file);
		stopIfCancelled();
		show(0, "Starting the upload");
		const created = await call<{ videoId: string }>(
			"/create",
			{ appId, name: name.slice(0, 255) },
			signal,
			false,
		);
		videoId = created.videoId;
		show(0, "Starting the upload");
		stopIfCancelled();
		const initiated = await call<{ uploadId: string }>(
			"/initiate",
			{ appId, videoId, contentType: file.type || "video/mp4" },
			signal,
			false,
		);
		uploadId = initiated.uploadId;
		stopIfCancelled();

		const partBytes = partBytesFor(file.size);
		const parts: { partNumber: number; etag: string; size: number }[] = [];
		const total = Math.max(1, Math.ceil(file.size / partBytes));
		const urls = new Map<number, string>();
		const urlFor = async (partNumber: number) => {
			if (!urls.has(partNumber)) {
				const batch = await call<{
					parts: { partNumber: number; presignedUrl: string }[];
				}>(
					"/presign",
					{
						appId,
						videoId,
						uploadId,
						partNumbers: presignBatch(partNumber, total),
					},
					signal,
				);
				for (const part of batch.parts) {
					urls.set(part.partNumber, part.presignedUrl);
				}
			}
			const url = urls.get(partNumber);
			urls.delete(partNumber);
			if (!url) throw new UploadError("A part of the file failed to upload");
			return url;
		};
		for (let index = 0; index < total; index++) {
			const blob = file.slice(index * partBytes, (index + 1) * partBytes);
			const sent = index * partBytes;
			let etag: string | null = null;
			for (let attempt = 1; !etag; attempt++) {
				stopIfCancelled();
				try {
					const presignedUrl = await urlFor(index + 1);
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
				await call("/complete", {
					appId,
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
				const code = error instanceof UploadError ? error.code : null;
				if (isDefinitiveRejection(status, code)) {
					outcome = "open";
					throw error;
				}
				const plan = completeRetryPlan(attempt, code, COMPLETE_ATTEMPTS);
				if (!plan.retry) throw error;
				await new Promise((resolve) => setTimeout(resolve, plan.waitMs));
			}
		}
		return { result: "done", videoId };
	} catch (error) {
		if (outcome === "unconfirmed") return { result: "unconfirmed" };
		let completingElsewhere = false;
		if (videoId && uploadId) {
			await call("/abort", { appId, videoId, uploadId }).catch((failure) => {
				completingElsewhere =
					failure instanceof UploadError &&
					failure.code === COMPLETION_IN_PROGRESS;
			});
		}
		if (videoId && !completingElsewhere) {
			await deleteDeveloperVideo(appId, videoId).catch(() => {});
		}
		if (signal.aborted) return { result: "cancelled" };
		return {
			result: "failed",
			needsCredits: error instanceof UploadError && error.status === 402,
			message: error instanceof Error ? error.message : "The upload failed",
		};
	}
}

export function UploadsProvider({
	appId,
	balanceMicroCredits,
	children,
}: {
	appId: string;
	balanceMicroCredits: number;
	children: ReactNode;
}) {
	const router = useRouter();
	const queue = useRef<File[]>([]);
	const running = useRef(false);
	const controller = useRef<AbortController | null>(null);
	const nextFailureId = useRef(0);
	const balance = useRef(balanceMicroCredits);
	const [active, setActive] = useState<ActiveUpload | null>(null);
	const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
	const [sentVideoIds, setSentVideoIds] = useState<ReadonlySet<string>>(
		NO_LOCAL_UPLOADS.sent,
	);
	const [pageWork, setPageWork] = useState<string | null>(null);
	const [waiting, setWaiting] = useState(0);
	const [failures, setFailures] = useState<
		(UploadFailure & { balance: number })[]
	>([]);
	balance.current = balanceMicroCredits;

	useEffect(
		() => () => {
			queue.current = [];
			controller.current?.abort();
		},
		[],
	);

	useWarnBeforeUnload(active ? LEAVE_DURING_UPLOAD : null);

	const pump = useCallback(async () => {
		if (running.current) return;
		running.current = true;
		try {
			for (
				let file = queue.current.shift();
				file;
				file = queue.current.shift()
			) {
				setWaiting(queue.current.length);
				const abort = new AbortController();
				controller.current = abort;
				let listed = false;
				const outcome = await uploadFile(
					appId,
					file,
					abort.signal,
					(upload, videoId) => {
						setActive(upload);
						setActiveVideoId(videoId);
						if (videoId && !listed) {
							listed = true;
							router.refresh();
						}
					},
				);
				if (controller.current === abort) controller.current = null;
				const failed = (
					message: string,
					needsCredits: boolean,
					skipped: number,
				) =>
					setFailures((current) => [
						...current,
						{
							id: nextFailureId.current++,
							name: file.name,
							message,
							needsCredits,
							skipped,
							balance: balance.current,
						},
					]);
				if (outcome.result === "done") {
					const { videoId } = outcome;
					setSentVideoIds((sent) => new Set(sent).add(videoId));
					toast.success(`Uploaded ${file.name}`);
					router.refresh();
				} else if (outcome.result === "unconfirmed") {
					failed(
						"The file is uploaded but the server has not confirmed it. Check the list before trying again.",
						false,
						0,
					);
					router.refresh();
				} else if (outcome.result === "failed") {
					// Every file after one refused for credit would be refused too.
					const skipped = outcome.needsCredits ? queue.current.length : 0;
					if (outcome.needsCredits) queue.current = [];
					failed(outcome.message, outcome.needsCredits, skipped);
				}
			}
		} finally {
			running.current = false;
			setActive(null);
			setActiveVideoId(null);
			setWaiting(0);
		}
	}, [appId, router]);

	const add = useCallback(
		(files: readonly File[]) => {
			if (files.length === 0) return;
			if (!running.current) setFailures([]);
			queue.current.push(...files);
			setWaiting(queue.current.length);
			void pump();
		},
		[pump],
	);

	const cancel = useCallback(() => {
		queue.current = [];
		setWaiting(0);
		controller.current?.abort();
	}, []);

	const uploads = useMemo<Uploads>(
		() => ({
			appId,
			active,
			waiting,
			// A refusal for credit stops being true once the balance has grown.
			failures: failures.filter(
				(failure) =>
					!failure.needsCredits || balanceMicroCredits <= failure.balance,
			),
			add,
			cancel,
		}),
		[appId, active, waiting, failures, balanceMicroCredits, add, cancel],
	);

	const local = useMemo<LocalUploads>(
		() => ({ sending: activeVideoId, sent: sentVideoIds }),
		[activeVideoId, sentVideoIds],
	);
	const work = useMemo<PageWork>(
		() => ({ message: pageWork, set: setPageWork }),
		[pageWork],
	);

	return (
		<UploadsContext.Provider value={uploads}>
			<LocalUploadsContext.Provider value={local}>
				<PageWorkContext.Provider value={work}>
					{children}
				</PageWorkContext.Provider>
			</LocalUploadsContext.Provider>
		</UploadsContext.Provider>
	);
}
