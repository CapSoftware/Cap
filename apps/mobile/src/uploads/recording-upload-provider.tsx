import * as FileSystem from "expo-file-system/legacy";
import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useEffect,
	useRef,
	useState,
} from "react";
import { AppState } from "react-native";
import { uploadToTarget } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import type { CapRecorderSegmentEvent } from "../../modules/cap-recorder";
import {
	emptyRecordingUploadQueue,
	hydrateRecordingUploadQueue,
	type RecordingUploadJob,
	type RecordingUploadQueue,
	type RecordingUploadQueueAction,
	recordingUploadQueueReducer,
} from "./recording-upload-queue";

const persistedQueueUri = FileSystem.documentDirectory
	? `${FileSystem.documentDirectory}recording-upload-queue.json`
	: null;
const completionDisplayDurationMs = 4000;
const maximumRetryDelayMs = 30_000;

type BeginRecordingInput = {
	fileName: string;
	width: number;
	height: number;
	fps: number;
};

type RecordingUploadContextValue = {
	queue: RecordingUploadQueue;
	beginRecording: (input: BeginRecordingInput) => Promise<{
		id: string;
		shareUrl: string;
	}>;
	addSegment: (id: string, segment: CapRecorderSegmentEvent) => void;
	finishRecording: (
		id: string,
		result: {
			durationSeconds: number;
			totalBytes: number;
		},
	) => void;
	discardRecording: (id: string) => Promise<void>;
	failRecording: (id: string, error: string) => void;
	retryRecording: (id: string) => void;
};

const RecordingUploadContext =
	createContext<RecordingUploadContextValue | null>(null);

const segmentSubpath = (segment: RecordingUploadJob["segments"][number]) =>
	segment.type === "initialization"
		? `segments/${segment.track}/init.mp4`
		: `segments/${segment.track}/segment_${String(segment.index).padStart(3, "0")}.m4s`;

const recordingDirectoryFromSegment = (
	segment: RecordingUploadJob["segments"][number] | undefined,
) => {
	if (!segment) return null;
	const separator = segment.uri.lastIndexOf("/");
	return separator > 0 ? segment.uri.slice(0, separator) : null;
};

const errorMessage = (error: unknown) =>
	error instanceof Error
		? error.message
		: "The recording upload was interrupted.";

export function RecordingUploadProvider({ children }: { children: ReactNode }) {
	const auth = useAuth();
	const [queue, setQueue] = useState(emptyRecordingUploadQueue);
	const queueRef = useRef(queue);
	const processingJobs = useRef(new Set<string>());
	const removedJobs = useRef(new Set<string>());
	const persistence = useRef(Promise.resolve());
	const processJobRef = useRef<(id: string) => Promise<void>>(async () => {});
	const hydrationResolve = useRef<(() => void) | null>(null);
	const hydration = useRef(
		new Promise<void>((resolve) => {
			hydrationResolve.current = resolve;
		}),
	);

	const persist = useCallback((nextQueue: RecordingUploadQueue) => {
		if (!persistedQueueUri) return;
		persistence.current = persistence.current
			.catch(() => undefined)
			.then(() =>
				FileSystem.writeAsStringAsync(
					persistedQueueUri,
					JSON.stringify(nextQueue),
				),
			)
			.catch(() => undefined);
	}, []);

	const kick = useCallback(() => {
		queueMicrotask(() => {
			for (const job of queueRef.current.jobs) {
				if (
					job.status !== "failed" &&
					job.status !== "complete" &&
					!processingJobs.current.has(job.id)
				) {
					void processJobRef.current(job.id);
				}
			}
		});
	}, []);

	const apply = useCallback(
		(action: RecordingUploadQueueAction) => {
			const nextQueue = recordingUploadQueueReducer(queueRef.current, action);
			queueRef.current = nextQueue;
			setQueue(nextQueue);
			persist(nextQueue);
			kick();
		},
		[kick, persist],
	);

	useEffect(() => {
		void (async () => {
			let restored = emptyRecordingUploadQueue;
			if (persistedQueueUri) {
				try {
					const value = JSON.parse(
						await FileSystem.readAsStringAsync(persistedQueueUri),
					) as unknown;
					restored = hydrateRecordingUploadQueue(value);
				} catch {
					restored = emptyRecordingUploadQueue;
				}
			}
			queueRef.current = restored;
			setQueue(restored);
			hydrationResolve.current?.();
			hydrationResolve.current = null;
			kick();
		})();
	}, [kick]);

	processJobRef.current = async (id: string) => {
		if (auth.status !== "signedIn" || processingJobs.current.has(id)) return;
		processingJobs.current.add(id);
		try {
			while (!removedJobs.current.has(id)) {
				const job = queueRef.current.jobs.find(
					(candidate) => candidate.id === id,
				);
				if (!job || job.status === "failed" || job.status === "complete")
					return;
				const pendingSegments = job.segments.filter(
					(segment) => !segment.uploaded,
				);
				if (pendingSegments.length > 0) {
					const batch = pendingSegments.slice(0, 4);
					const subpaths = batch.map(segmentSubpath);
					const { uploads } = await auth.client.createRecordingUploadTargets(
						job.id,
						subpaths,
					);
					await Promise.all(
						batch.map(async (segment, index) => {
							const subpath = subpaths[index];
							const target = subpath ? uploads[subpath] : undefined;
							if (!target) throw new Error("Cap could not prepare the upload.");
							await uploadToTarget(target, {
								uri: segment.uri,
								name: subpath,
								type: "video/mp4",
								size: segment.byteLength,
							});
							apply({
								type: "segmentUploaded",
								id: job.id,
								index: segment.index,
								track: segment.track,
								segmentType: segment.type,
							});
						}),
					);
					continue;
				}

				if (job.durationSeconds === null) return;
				const videoSegments = job.segments
					.filter(
						(segment) => segment.track === "video" && segment.type === "media",
					)
					.sort((a, b) => a.index - b.index);
				const audioSegments = job.segments
					.filter(
						(segment) => segment.track === "audio" && segment.type === "media",
					)
					.sort((a, b) => a.index - b.index);
				const hasVideoInitialization = job.segments.some(
					(segment) =>
						segment.track === "video" && segment.type === "initialization",
				);
				const hasAudioInitialization = job.segments.some(
					(segment) =>
						segment.track === "audio" && segment.type === "initialization",
				);
				if (!hasVideoInitialization || videoSegments.length === 0) {
					throw new Error("The camera did not produce a playable recording.");
				}
				if (audioSegments.length > 0 && !hasAudioInitialization) {
					throw new Error(
						"The microphone did not produce a playable recording.",
					);
				}

				apply({ type: "processing", id: job.id });
				await auth.client.completeRecording(job.id, {
					durationSeconds: job.durationSeconds,
					totalBytes: job.totalBytes,
					videoSegments: videoSegments.map((segment) => ({
						index: segment.index,
						duration: segment.durationSeconds,
					})),
					audioSegments: audioSegments.map((segment) => ({
						index: segment.index,
						duration: segment.durationSeconds,
					})),
				});
				await auth.refresh().catch(() => undefined);
				const directory = recordingDirectoryFromSegment(job.segments[0]);
				if (directory) {
					await FileSystem.deleteAsync(directory, { idempotent: true }).catch(
						() => undefined,
					);
				}
				apply({ type: "complete", id: job.id });
				setTimeout(
					() => apply({ type: "remove", id: job.id }),
					completionDisplayDurationMs,
				);
				return;
			}
		} catch (error) {
			apply({ type: "fail", id, error: errorMessage(error) });
			const retryCount =
				queueRef.current.jobs.find((candidate) => candidate.id === id)
					?.retryCount ?? 1;
			const retryDelay = Math.min(
				maximumRetryDelayMs,
				1000 * 2 ** Math.min(retryCount - 1, 5),
			);
			setTimeout(() => {
				const job = queueRef.current.jobs.find(
					(candidate) => candidate.id === id,
				);
				if (job?.status === "failed" && !removedJobs.current.has(id)) {
					apply({ type: "retry", id });
				}
			}, retryDelay);
		} finally {
			processingJobs.current.delete(id);
		}
	};

	useEffect(() => {
		if (auth.status !== "signedIn") return;
		for (const job of queueRef.current.jobs) {
			if (job.status === "failed" && job.durationSeconds !== null) {
				apply({ type: "retry", id: job.id });
			}
		}
		kick();
	}, [apply, auth.status, kick]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") return;
			for (const job of queueRef.current.jobs) {
				if (job.status === "failed" && job.durationSeconds !== null) {
					apply({ type: "retry", id: job.id });
				}
			}
			kick();
		});
		return () => subscription.remove();
	}, [apply, kick]);

	const beginRecording = useCallback(
		async (input: BeginRecordingInput) => {
			await hydration.current;
			if (auth.status !== "signedIn") {
				throw new Error("Sign in before recording.");
			}
			const created = await auth.client.createRecording({
				...input,
				organizationId: auth.bootstrap?.activeOrganizationId ?? undefined,
			});
			removedJobs.current.delete(created.id);
			apply({ type: "begin", id: created.id, shareUrl: created.shareUrl });
			return { id: created.id, shareUrl: created.shareUrl };
		},
		[apply, auth],
	);

	const addSegment = useCallback(
		(id: string, segment: CapRecorderSegmentEvent) => {
			apply({ type: "segment", id, segment });
		},
		[apply],
	);

	const finishRecording = useCallback(
		(id: string, result: { durationSeconds: number; totalBytes: number }) => {
			apply({ type: "finish", id, ...result });
		},
		[apply],
	);

	const failRecording = useCallback(
		(id: string, error: string) => {
			apply({ type: "fail", id, error });
		},
		[apply],
	);

	const retryRecording = useCallback(
		(id: string) => {
			apply({ type: "retry", id });
		},
		[apply],
	);

	const discardRecording = useCallback(
		async (id: string) => {
			removedJobs.current.add(id);
			const job = queueRef.current.jobs.find(
				(candidate) => candidate.id === id,
			);
			apply({ type: "remove", id });
			const directory = recordingDirectoryFromSegment(job?.segments[0]);
			await Promise.all([
				auth.status === "signedIn"
					? auth.client.deleteCap(id).catch(() => undefined)
					: Promise.resolve(),
				directory
					? FileSystem.deleteAsync(directory, { idempotent: true }).catch(
							() => undefined,
						)
					: Promise.resolve(),
			]);
		},
		[apply, auth],
	);

	return (
		<RecordingUploadContext.Provider
			value={{
				queue,
				beginRecording,
				addSegment,
				finishRecording,
				discardRecording,
				failRecording,
				retryRecording,
			}}
		>
			{children}
		</RecordingUploadContext.Provider>
	);
}

export const useRecordingUploads = () => {
	const value = useContext(RecordingUploadContext);
	if (!value) {
		throw new Error("useRecordingUploads must be used within its provider.");
	}
	return value;
};
