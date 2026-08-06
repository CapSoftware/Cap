import * as FileSystem from "expo-file-system/legacy";
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
import { AppState } from "react-native";
import { uploadToTarget } from "@/api/mobile";
import { useAuth } from "@/auth/AuthContext";
import type { CapRecorderSegmentEvent } from "../../modules/cap-recorder";
import {
	cancelScreenRecording,
	getScreenRecordingUpdates,
} from "../../modules/cap-screen-recorder";
import {
	emptyRecordingUploadQueue,
	hydrateRecordingUploadQueue,
	type RecordingUploadJob,
	type RecordingUploadOwner,
	type RecordingUploadQueue,
	type RecordingUploadQueueAction,
	recordingUploadQueueReducer,
} from "./recording-upload-queue";

const persistedQueueUri = FileSystem.documentDirectory
	? `${FileSystem.documentDirectory}recording-upload-queue.json`
	: null;
const completionDisplayDurationMs = 4000;
const externalReconcileIntervalMs = 750;
const maximumRetryDelayMs = 30_000;
const progressReportIntervalMs = 1500;
const serverReconcileIntervalMs = 3000;
const segmentPersistDelayMs = 1000;

type BeginRecordingInput = {
	fileName: string;
	width: number;
	height: number;
	fps: number;
	uploadOwner?: RecordingUploadOwner;
};

type RecordingUploadActions = {
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
	dismissRecording: (id: string) => void;
	failRecording: (id: string, error: string) => void;
	retryRecording: (id: string) => void;
};

type RecordingUploadContextValue = RecordingUploadActions & {
	queue: RecordingUploadQueue;
	libraryRevision: number;
};

const RecordingUploadActionsContext =
	createContext<RecordingUploadActions | null>(null);
const RecordingUploadQueueContext = createContext<RecordingUploadQueue | null>(
	null,
);
const RecordingUploadDisplayQueueContext =
	createContext<RecordingUploadQueue | null>(null);
const RecordingUploadLibraryRevisionContext = createContext<number | null>(
	null,
);

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

const displayQueueFrom = (
	queue: RecordingUploadQueue,
	current: RecordingUploadQueue = emptyRecordingUploadQueue,
) => {
	const jobs = queue.jobs.filter(
		(job) => job.status !== "recording" || job.uploadOwner === "external",
	);
	if (
		jobs.length === current.jobs.length &&
		jobs.every((job, index) => job === current.jobs[index])
	) {
		return current;
	}
	return { jobs };
};

const reconcileExternalRecordings = async (queue: RecordingUploadQueue) => {
	let nextQueue = queue;
	let libraryChanged = false;
	const cancelledIds: string[] = [];

	for (const job of queue.jobs) {
		if (job.uploadOwner !== "external") continue;
		try {
			const updates = await getScreenRecordingUpdates(job.id);
			if (updates.status === "uploaded") {
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "externalProcessing",
					id: job.id,
					durationSeconds: updates.durationSeconds,
					totalBytes: updates.totalBytes,
				});
				libraryChanged = true;
				continue;
			}
			if (updates.status === "uploading") {
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "externalProcessing",
					id: job.id,
					durationSeconds: updates.durationSeconds,
					totalBytes: updates.totalBytes,
				});
				continue;
			}
			if (updates.status === "finished") {
				for (const segment of updates.segments) {
					nextQueue = recordingUploadQueueReducer(nextQueue, {
						type: "segment",
						id: job.id,
						segment,
					});
				}
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "finish",
					id: job.id,
					durationSeconds: updates.durationSeconds ?? 0.1,
					totalBytes: updates.totalBytes,
				});
				continue;
			}
			if (updates.status === "cancelled") {
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "remove",
					id: job.id,
				});
				cancelledIds.push(job.id);
				libraryChanged = true;
				continue;
			}
			if (updates.status === "missing") {
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "fail",
					id: job.id,
					error: "The screen recording could not be recovered.",
				});
				continue;
			}
			if (
				updates.status === "failed" &&
				(job.status !== "failed" || job.error !== updates.error)
			) {
				nextQueue = recordingUploadQueueReducer(nextQueue, {
					type: "fail",
					id: job.id,
					error: updates.error ?? "The screen recording stopped unexpectedly.",
				});
			}
		} catch {}
	}

	return { cancelledIds, libraryChanged, queue: nextQueue };
};

export function RecordingUploadProvider({ children }: { children: ReactNode }) {
	const auth = useAuth();
	const authStatus = auth.status;
	const authClient = auth.client;
	const activeOrganizationId = auth.bootstrap?.activeOrganizationId;
	const refreshAuth = auth.refresh;
	const [queue, setQueue] = useState(emptyRecordingUploadQueue);
	const [displayQueue, setDisplayQueue] = useState(emptyRecordingUploadQueue);
	const [libraryRevision, setLibraryRevision] = useState(0);
	const queueRef = useRef(queue);
	const processingJobs = useRef(new Set<string>());
	const progressReportTimes = useRef(new Map<string, number>());
	const progressReports = useRef(new Map<string, Promise<void>>());
	const removedJobs = useRef(new Set<string>());
	const persistence = useRef(Promise.resolve());
	const processJobRef = useRef<(id: string) => Promise<void>>(async () => {});
	const hydrationResolve = useRef<(() => void) | null>(null);
	const hydrationStarted = useRef(false);
	const hydration = useRef(
		new Promise<void>((resolve) => {
			hydrationResolve.current = resolve;
		}),
	);

	const pendingPersistQueue = useRef<RecordingUploadQueue | null>(null);
	const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const flushPersist = useCallback(() => {
		if (persistTimer.current) {
			clearTimeout(persistTimer.current);
			persistTimer.current = null;
		}
		const nextQueue = pendingPersistQueue.current;
		pendingPersistQueue.current = null;
		if (!nextQueue || !persistedQueueUri) return;
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

	const persist = useCallback(
		(nextQueue: RecordingUploadQueue, immediate: boolean) => {
			if (!persistedQueueUri) return;
			pendingPersistQueue.current = nextQueue;
			if (immediate) {
				flushPersist();
				return;
			}
			if (persistTimer.current) return;
			persistTimer.current = setTimeout(() => {
				persistTimer.current = null;
				flushPersist();
			}, segmentPersistDelayMs);
		},
		[flushPersist],
	);

	const kick = useCallback(() => {
		queueMicrotask(() => {
			for (const job of queueRef.current.jobs) {
				if (
					job.uploadOwner === "app" &&
					(job.status === "recording" || job.status === "uploading") &&
					job.serverPhase === null &&
					!processingJobs.current.has(job.id)
				) {
					void processJobRef.current(job.id);
				}
			}
		});
	}, []);

	const apply = useCallback(
		(action: RecordingUploadQueueAction) => {
			const currentQueue = queueRef.current;
			const nextQueue = recordingUploadQueueReducer(currentQueue, action);
			if (nextQueue === currentQueue) return;
			if (action.type === "remove") {
				progressReportTimes.current.delete(action.id);
				progressReports.current.delete(action.id);
			}
			queueRef.current = nextQueue;
			setQueue(nextQueue);
			setDisplayQueue((current) => displayQueueFrom(nextQueue, current));
			persist(
				nextQueue,
				action.type !== "segment" && action.type !== "segmentUploaded",
			);
			kick();
		},
		[kick, persist],
	);
	const notifyLibraryChanged = useCallback(() => {
		setLibraryRevision((revision) => revision + 1);
	}, []);
	const externalRecordingIdsKey = useMemo(
		() =>
			queue.jobs
				.filter(
					(job) =>
						job.uploadOwner === "external" &&
						job.status !== "failed" &&
						job.status !== "complete",
				)
				.map((job) => job.id)
				.sort()
				.join(","),
		[queue.jobs],
	);
	const serverTrackedIdsKey = useMemo(
		() =>
			queue.jobs
				.filter(
					(job) =>
						job.status === "processing" ||
						job.serverPhase !== null ||
						(job.uploadOwner === "external" && job.status === "uploading"),
				)
				.map((job) => job.id)
				.sort()
				.join(","),
		[queue.jobs],
	);

	useEffect(() => {
		if (hydrationStarted.current) return;
		hydrationStarted.current = true;
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
			const reconciliation = await reconcileExternalRecordings(restored);
			restored = reconciliation.queue;
			for (const id of reconciliation.cancelledIds) {
				removedJobs.current.add(id);
				void cancelScreenRecording(id).catch(() => undefined);
				if (authStatus === "signedIn") {
					void authClient.deleteCap(id).catch(() => undefined);
				}
			}
			queueRef.current = restored;
			setQueue(restored);
			setDisplayQueue(displayQueueFrom(restored));
			persist(restored, true);
			if (reconciliation.libraryChanged) {
				notifyLibraryChanged();
				void refreshAuth().catch(() => undefined);
			}
			hydrationResolve.current?.();
			hydrationResolve.current = null;
			kick();
		})();
	}, [
		authClient,
		authStatus,
		kick,
		notifyLibraryChanged,
		persist,
		refreshAuth,
	]);

	useEffect(() => {
		if (externalRecordingIdsKey.length === 0) return;
		let cancelled = false;
		let inFlight = false;
		const reconcile = async () => {
			if (cancelled || inFlight) return;
			inFlight = true;
			try {
				const jobs = queueRef.current.jobs.filter(
					(job) =>
						job.uploadOwner === "external" &&
						job.status !== "failed" &&
						job.status !== "complete",
				);
				const results = await Promise.all(
					jobs.map(async (job) => {
						try {
							return {
								id: job.id,
								updates: await getScreenRecordingUpdates(job.id),
							};
						} catch {
							return null;
						}
					}),
				);
				if (cancelled) return;
				for (const result of results) {
					if (!result) continue;
					const job = queueRef.current.jobs.find(
						(candidate) => candidate.id === result.id,
					);
					if (!job || job.uploadOwner !== "external") continue;
					const updates = result.updates;
					if (!updates) continue;
					if (updates.status === "cancelled") {
						removedJobs.current.add(job.id);
						apply({ type: "remove", id: job.id });
						await Promise.all([
							authClient.deleteCap(job.id).catch(() => undefined),
							cancelScreenRecording(job.id).catch(() => undefined),
						]);
						notifyLibraryChanged();
						continue;
					}
					if (updates.status === "missing") {
						apply({
							type: "fail",
							id: job.id,
							error: "The screen recording could not be recovered.",
						});
						continue;
					}
					if (updates.status === "uploading" || updates.status === "uploaded") {
						apply({
							type: "externalProcessing",
							id: job.id,
							durationSeconds: updates.durationSeconds,
							totalBytes: updates.totalBytes,
						});
						continue;
					}
					if (updates.status === "finished") {
						for (const segment of updates.segments) {
							apply({ type: "segment", id: job.id, segment });
						}
						apply({
							type: "finish",
							id: job.id,
							durationSeconds: updates.durationSeconds ?? 0.1,
							totalBytes: updates.totalBytes,
						});
						continue;
					}
					if (updates.status === "failed") {
						apply({
							type: "fail",
							id: job.id,
							error:
								updates.error ?? "The screen recording stopped unexpectedly.",
						});
					}
				}
			} finally {
				inFlight = false;
			}
		};
		void reconcile();
		const interval = setInterval(() => {
			void reconcile();
		}, externalReconcileIntervalMs);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [apply, authClient, externalRecordingIdsKey, notifyLibraryChanged]);

	useEffect(() => {
		if (authStatus !== "signedIn" || serverTrackedIdsKey.length === 0) return;
		const ids = serverTrackedIdsKey.split(",");
		let cancelled = false;
		let inFlight = false;
		const reconcile = async () => {
			if (cancelled || inFlight) return;
			inFlight = true;
			try {
				const response = await authClient.getCapStatuses(ids);
				if (cancelled) return;
				const statuses = new Map<
					string,
					(typeof response.caps)[number]["upload"]
				>(response.caps.map((cap) => [cap.id, cap.upload] as const));
				let libraryChanged = false;
				for (const id of ids) {
					const job = queueRef.current.jobs.find(
						(candidate) => candidate.id === id,
					);
					if (!job) continue;
					if (!statuses.has(id)) {
						removedJobs.current.add(id);
						apply({ type: "remove", id });
						if (job.uploadOwner === "external") {
							void cancelScreenRecording(id).catch(() => undefined);
						}
						continue;
					}
					const upload = statuses.get(id) ?? null;
					if (!upload || upload.phase === "complete") {
						apply({ type: "complete", id });
						if (job.uploadOwner === "external") {
							void cancelScreenRecording(id).catch(() => undefined);
						}
						setTimeout(
							() => apply({ type: "remove", id }),
							completionDisplayDurationMs,
						);
						libraryChanged = true;
						continue;
					}
					if (upload.phase === "error") {
						apply({
							type: "fail",
							id,
							error:
								upload.processingError ??
								upload.processingMessage ??
								"Cap could not finish processing this recording.",
						});
						libraryChanged = true;
						continue;
					}
					apply({
						type: "serverUpload",
						id,
						phase: upload.phase,
						uploaded: upload.uploaded,
						total: upload.total,
						progress: upload.processingProgress,
						message: upload.processingMessage,
					});
				}
				if (libraryChanged) {
					notifyLibraryChanged();
					void refreshAuth().catch(() => undefined);
				}
			} catch {
			} finally {
				inFlight = false;
			}
		};
		void reconcile();
		const interval = setInterval(() => {
			void reconcile();
		}, serverReconcileIntervalMs);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [
		apply,
		authClient,
		authStatus,
		notifyLibraryChanged,
		refreshAuth,
		serverTrackedIdsKey,
	]);

	processJobRef.current = async (id: string) => {
		if (authStatus !== "signedIn" || processingJobs.current.has(id)) return;
		processingJobs.current.add(id);
		try {
			while (!removedJobs.current.has(id)) {
				const job = queueRef.current.jobs.find(
					(candidate) => candidate.id === id,
				);
				if (
					!job ||
					job.uploadOwner !== "app" ||
					job.status === "failed" ||
					job.status === "complete" ||
					job.status === "processing" ||
					job.serverPhase !== null
				)
					return;
				const pendingSegments = job.segments.filter(
					(segment) => !segment.uploaded,
				);
				if (pendingSegments.length > 0) {
					const batch = pendingSegments.slice(0, 4);
					const subpaths = batch.map(segmentSubpath);
					const { uploads } = await authClient.createRecordingUploadTargets(
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
					const latestJob = queueRef.current.jobs.find(
						(candidate) => candidate.id === job.id,
					);
					const now = Date.now();
					const lastReport = progressReportTimes.current.get(job.id) ?? 0;
					if (latestJob && now - lastReport >= progressReportIntervalMs) {
						progressReportTimes.current.set(job.id, now);
						const previous =
							progressReports.current.get(job.id) ?? Promise.resolve();
						const report = previous
							.catch(() => undefined)
							.then(() =>
								authClient.updateUploadProgress(job.id, {
									uploaded: latestJob.uploadedBytes,
									total: latestJob.totalBytes,
								}),
							)
							.then(() => undefined)
							.catch(() => undefined);
						progressReports.current.set(job.id, report);
					}
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
					throw new Error("The recording did not produce playable video.");
				}
				if (audioSegments.length > 0 && !hasAudioInitialization) {
					throw new Error(
						"The recording did not produce playable microphone audio.",
					);
				}

				apply({ type: "processing", id: job.id });
				await authClient.completeRecording(job.id, {
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
				notifyLibraryChanged();
				await refreshAuth().catch(() => undefined);
				const directory = recordingDirectoryFromSegment(job.segments[0]);
				if (directory) {
					await FileSystem.deleteAsync(directory, { idempotent: true }).catch(
						() => undefined,
					);
				}
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
		if (authStatus !== "signedIn") return;
		for (const job of queueRef.current.jobs) {
			if (
				job.uploadOwner === "app" &&
				job.status === "failed" &&
				job.durationSeconds !== null
			) {
				apply({ type: "retry", id: job.id });
			}
		}
		kick();
	}, [apply, authStatus, kick]);

	useEffect(() => {
		const subscription = AppState.addEventListener("change", (state) => {
			if (state !== "active") {
				flushPersist();
				return;
			}
			for (const job of queueRef.current.jobs) {
				if (
					job.uploadOwner === "app" &&
					job.status === "failed" &&
					job.durationSeconds !== null
				) {
					apply({ type: "retry", id: job.id });
				}
			}
			kick();
		});
		return () => subscription.remove();
	}, [apply, flushPersist, kick]);

	useEffect(() => {
		if (authStatus !== "signedOut") return;
		void (async () => {
			await hydration.current;
			const jobs = queueRef.current.jobs;
			if (persistTimer.current) {
				clearTimeout(persistTimer.current);
				persistTimer.current = null;
			}
			pendingPersistQueue.current = null;
			for (const job of jobs) {
				removedJobs.current.add(job.id);
			}
			queueRef.current = emptyRecordingUploadQueue;
			setQueue(emptyRecordingUploadQueue);
			setDisplayQueue(emptyRecordingUploadQueue);
			await Promise.all(
				jobs.map((job) => {
					const directory = recordingDirectoryFromSegment(job.segments[0]);
					return directory
						? FileSystem.deleteAsync(directory, { idempotent: true }).catch(
								() => undefined,
							)
						: Promise.resolve();
				}),
			);
			if (persistedQueueUri) {
				await FileSystem.deleteAsync(persistedQueueUri, {
					idempotent: true,
				}).catch(() => undefined);
			}
		})();
	}, [authStatus]);

	const beginRecording = useCallback(
		async (input: BeginRecordingInput) => {
			await hydration.current;
			if (authStatus !== "signedIn") {
				throw new Error("Sign in before recording.");
			}
			const { uploadOwner = "app", ...recordingInput } = input;
			const created = await authClient.createRecording({
				...recordingInput,
				organizationId: activeOrganizationId ?? undefined,
			});
			removedJobs.current.delete(created.id);
			apply({
				type: "begin",
				id: created.id,
				shareUrl: created.shareUrl,
				uploadOwner,
			});
			notifyLibraryChanged();
			return { id: created.id, shareUrl: created.shareUrl };
		},
		[activeOrganizationId, apply, authClient, authStatus, notifyLibraryChanged],
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
				authStatus === "signedIn"
					? authClient.deleteCap(id).catch(() => undefined)
					: Promise.resolve(),
				directory
					? FileSystem.deleteAsync(directory, { idempotent: true }).catch(
							() => undefined,
						)
					: Promise.resolve(),
			]);
			notifyLibraryChanged();
		},
		[apply, authClient, authStatus, notifyLibraryChanged],
	);

	const dismissRecording = useCallback(
		(id: string) => {
			removedJobs.current.add(id);
			apply({ type: "remove", id });
		},
		[apply],
	);

	const actions = useMemo<RecordingUploadActions>(
		() => ({
			beginRecording,
			addSegment,
			finishRecording,
			discardRecording,
			dismissRecording,
			failRecording,
			retryRecording,
		}),
		[
			beginRecording,
			addSegment,
			finishRecording,
			discardRecording,
			dismissRecording,
			failRecording,
			retryRecording,
		],
	);

	return (
		<RecordingUploadActionsContext.Provider value={actions}>
			<RecordingUploadLibraryRevisionContext.Provider value={libraryRevision}>
				<RecordingUploadQueueContext.Provider value={queue}>
					<RecordingUploadDisplayQueueContext.Provider value={displayQueue}>
						{children}
					</RecordingUploadDisplayQueueContext.Provider>
				</RecordingUploadQueueContext.Provider>
			</RecordingUploadLibraryRevisionContext.Provider>
		</RecordingUploadActionsContext.Provider>
	);
}

export const useRecordingUploadActions = () => {
	const actions = useContext(RecordingUploadActionsContext);
	if (!actions) {
		throw new Error(
			"useRecordingUploadActions must be used within its provider.",
		);
	}
	return actions;
};

export const useRecordingUploadQueue = () => {
	const queue = useContext(RecordingUploadQueueContext);
	if (!queue) {
		throw new Error(
			"useRecordingUploadQueue must be used within its provider.",
		);
	}
	return queue;
};

export const useRecordingUploadDisplayQueue = () => {
	const queue = useContext(RecordingUploadDisplayQueueContext);
	if (!queue) {
		throw new Error(
			"useRecordingUploadDisplayQueue must be used within its provider.",
		);
	}
	return queue;
};

export const useRecordingUploadLibraryRevision = () => {
	const revision = useContext(RecordingUploadLibraryRevisionContext);
	if (revision === null) {
		throw new Error(
			"useRecordingUploadLibraryRevision must be used within its provider.",
		);
	}
	return revision;
};

export const useRecordingUploads = (): RecordingUploadContextValue => {
	const actions = useRecordingUploadActions();
	const queue = useRecordingUploadQueue();
	const libraryRevision = useRecordingUploadLibraryRevision();
	return useMemo(
		() => ({ ...actions, queue, libraryRevision }),
		[actions, libraryRevision, queue],
	);
};
