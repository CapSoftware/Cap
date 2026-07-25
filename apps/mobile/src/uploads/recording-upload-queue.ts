export type RecordingUploadStatus =
	| "recording"
	| "uploading"
	| "processing"
	| "failed"
	| "complete";

export type RecordingUploadOwner = "app" | "external";

export type RecordingUploadServerPhase =
	| "uploading"
	| "processing"
	| "generating_thumbnail"
	| "complete";

export type RecordingUploadSegment = {
	track: "video" | "audio";
	type: "initialization" | "media";
	index: number;
	uri: string;
	durationSeconds: number;
	byteLength: number;
	uploaded: boolean;
};

export type RecordingUploadJob = {
	id: string;
	shareUrl: string;
	createdAt: string;
	status: RecordingUploadStatus;
	durationSeconds: number | null;
	totalBytes: number;
	uploadedBytes: number;
	segments: RecordingUploadSegment[];
	uploadOwner: RecordingUploadOwner;
	serverPhase: RecordingUploadServerPhase | null;
	processingProgress: number;
	processingMessage: string | null;
	error: string | null;
	retryCount: number;
};

export type RecordingUploadQueue = {
	jobs: RecordingUploadJob[];
};

export type RecordingUploadQueueAction =
	| {
			type: "begin";
			id: string;
			shareUrl: string;
			uploadOwner?: RecordingUploadOwner;
	  }
	| {
			type: "segment";
			id: string;
			segment: Omit<RecordingUploadSegment, "uploaded">;
	  }
	| { type: "finish"; id: string; durationSeconds: number; totalBytes: number }
	| {
			type: "segmentUploaded";
			id: string;
			index: number;
			track: RecordingUploadSegment["track"];
			segmentType: RecordingUploadSegment["type"];
	  }
	| {
			type: "processing";
			id: string;
			progress?: number;
			message?: string | null;
			serverPhase?: RecordingUploadServerPhase | null;
	  }
	| {
			type: "externalProcessing";
			id: string;
			durationSeconds: number | null;
			totalBytes: number;
	  }
	| {
			type: "serverUpload";
			id: string;
			phase: RecordingUploadServerPhase;
			uploaded: number;
			total: number;
			progress: number;
			message: string | null;
	  }
	| { type: "complete"; id: string }
	| { type: "fail"; id: string; error: string }
	| { type: "retry"; id: string }
	| { type: "remove"; id: string };

export const emptyRecordingUploadQueue: RecordingUploadQueue = { jobs: [] };

const updateJob = (
	queue: RecordingUploadQueue,
	id: string,
	update: (job: RecordingUploadJob) => RecordingUploadJob,
): RecordingUploadQueue => {
	const index = queue.jobs.findIndex((job) => job.id === id);
	const current = queue.jobs[index];
	if (!current) return queue;
	const next = update(current);
	if (next === current) return queue;
	const jobs = [...queue.jobs];
	jobs[index] = next;
	return { jobs };
};

export const recordingUploadQueueReducer = (
	queue: RecordingUploadQueue,
	action: RecordingUploadQueueAction,
): RecordingUploadQueue => {
	switch (action.type) {
		case "begin":
			return {
				jobs: [
					...queue.jobs.filter((job) => job.id !== action.id),
					{
						id: action.id,
						shareUrl: action.shareUrl,
						createdAt: new Date().toISOString(),
						status: "recording",
						durationSeconds: null,
						totalBytes: 0,
						uploadedBytes: 0,
						segments: [],
						uploadOwner: action.uploadOwner ?? "app",
						serverPhase: null,
						processingProgress: 0,
						processingMessage: null,
						error: null,
						retryCount: 0,
					},
				],
			};
		case "segment":
			return updateJob(queue, action.id, (job) => {
				const exists = job.segments.some(
					(segment) =>
						segment.track === action.segment.track &&
						segment.type === action.segment.type &&
						segment.index === action.segment.index,
				);
				if (exists) return job;
				return {
					...job,
					totalBytes: job.totalBytes + action.segment.byteLength,
					segments: [...job.segments, { ...action.segment, uploaded: false }],
				};
			});
		case "finish":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: job.status === "failed" ? "failed" : "uploading",
				durationSeconds: action.durationSeconds,
				totalBytes: Math.max(job.totalBytes, action.totalBytes),
				uploadOwner: "app",
				serverPhase: null,
				processingProgress: 0,
				processingMessage: null,
			}));
		case "segmentUploaded":
			return updateJob(queue, action.id, (job) => {
				const segmentIndex = job.segments.findIndex(
					(segment) =>
						segment.track === action.track &&
						segment.type === action.segmentType &&
						segment.index === action.index,
				);
				const segment = job.segments[segmentIndex];
				if (!segment || segment.uploaded) return job;
				const segments = [...job.segments];
				segments[segmentIndex] = { ...segment, uploaded: true };
				return {
					...job,
					uploadedBytes: job.uploadedBytes + segment.byteLength,
					segments,
				};
			});
		case "processing":
			return updateJob(queue, action.id, (job) => {
				const processingProgress = action.progress ?? job.processingProgress;
				const processingMessage =
					action.message === undefined ? job.processingMessage : action.message;
				const serverPhase =
					action.serverPhase === undefined
						? job.serverPhase
						: action.serverPhase;
				if (
					job.status === "processing" &&
					job.processingProgress === processingProgress &&
					job.processingMessage === processingMessage &&
					job.serverPhase === serverPhase &&
					job.error === null
				) {
					return job;
				}
				return {
					...job,
					status: "processing",
					serverPhase,
					processingProgress,
					processingMessage,
					error: null,
				};
			});
		case "externalProcessing":
			return updateJob(queue, action.id, (job) => {
				if (job.status !== "recording" || job.uploadOwner !== "external") {
					return job;
				}
				return {
					...job,
					status: "processing",
					durationSeconds: action.durationSeconds,
					totalBytes: Math.max(job.totalBytes, action.totalBytes),
					serverPhase: null,
					processingProgress: 0,
					processingMessage: "Finishing your recording",
					error: null,
				};
			});
		case "serverUpload":
			return updateJob(queue, action.id, (job) => {
				const status =
					action.phase === "uploading" ? "uploading" : "processing";
				const totalBytes = Math.max(0, action.total);
				const uploadedBytes = Math.min(
					totalBytes,
					Math.max(0, action.uploaded),
				);
				const processingProgress = Math.min(100, Math.max(0, action.progress));
				if (
					job.status === status &&
					job.serverPhase === action.phase &&
					job.totalBytes === totalBytes &&
					job.uploadedBytes === uploadedBytes &&
					job.processingProgress === processingProgress &&
					job.processingMessage === action.message &&
					job.error === null
				) {
					return job;
				}
				return {
					...job,
					status,
					totalBytes,
					uploadedBytes,
					serverPhase: action.phase,
					processingProgress,
					processingMessage: action.message,
					error: null,
				};
			});
		case "complete":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: "complete",
				serverPhase: null,
				processingProgress: 100,
				processingMessage: null,
				error: null,
			}));
		case "fail":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: "failed",
				serverPhase: null,
				error: action.error,
				retryCount: job.retryCount + 1,
			}));
		case "retry":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: job.durationSeconds === null ? "recording" : "uploading",
				uploadOwner: "app",
				serverPhase: null,
				processingProgress: 0,
				processingMessage: null,
				error: null,
			}));
		case "remove": {
			const jobs = queue.jobs.filter((job) => job.id !== action.id);
			return jobs.length === queue.jobs.length ? queue : { jobs };
		}
	}
};

export const recordingUploadProgress = (job: RecordingUploadJob) => {
	if (job.status === "processing") {
		return Math.min(1, Math.max(0, job.processingProgress / 100));
	}
	if (job.totalBytes <= 0) return 0;
	return Math.min(1, Math.max(0, job.uploadedBytes / job.totalBytes));
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null;

const parseSegment = (value: unknown): RecordingUploadSegment | null => {
	if (!isRecord(value)) return null;
	if (value.track !== "video" && value.track !== "audio") return null;
	if (value.type !== "initialization" && value.type !== "media") return null;
	if (
		typeof value.index !== "number" ||
		typeof value.uri !== "string" ||
		typeof value.durationSeconds !== "number" ||
		typeof value.byteLength !== "number" ||
		typeof value.uploaded !== "boolean"
	) {
		return null;
	}
	return {
		track: value.track,
		type: value.type,
		index: value.index,
		uri: value.uri,
		durationSeconds: value.durationSeconds,
		byteLength: value.byteLength,
		uploaded: value.uploaded,
	};
};

const parseJob = (value: unknown): RecordingUploadJob | null => {
	if (!isRecord(value) || !Array.isArray(value.segments)) return null;
	if (
		typeof value.id !== "string" ||
		typeof value.shareUrl !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.totalBytes !== "number" ||
		typeof value.retryCount !== "number"
	) {
		return null;
	}
	const segments = value.segments.map(parseSegment);
	if (segments.some((segment) => segment === null)) return null;
	const parsedSegments = segments.filter(
		(segment): segment is RecordingUploadSegment => segment !== null,
	);
	const mediaDuration = parsedSegments.reduce(
		(total, segment) =>
			total +
			(segment.track === "video" && segment.type === "media"
				? segment.durationSeconds
				: 0),
		0,
	);
	const storedDuration =
		typeof value.durationSeconds === "number" ? value.durationSeconds : null;
	const durationSeconds =
		storedDuration ?? (mediaDuration > 0 ? mediaDuration : null);
	const storedStatus = value.status;
	const status: RecordingUploadStatus =
		storedStatus === "complete"
			? "complete"
			: storedStatus === "processing"
				? "processing"
				: storedStatus === "failed" && durationSeconds === null
					? "failed"
					: durationSeconds === null
						? "recording"
						: "uploading";
	const uploadOwner: RecordingUploadOwner =
		value.uploadOwner === "app" || value.uploadOwner === "external"
			? value.uploadOwner
			: parsedSegments.some((segment) =>
						segment.uri.includes("/CapScreenRecordings/"),
					)
				? "external"
				: "app";
	const serverPhase: RecordingUploadServerPhase | null =
		value.serverPhase === "uploading" ||
		value.serverPhase === "processing" ||
		value.serverPhase === "generating_thumbnail" ||
		value.serverPhase === "complete"
			? value.serverPhase
			: null;
	const segmentUploadedBytes = parsedSegments.reduce(
		(total, segment) => total + (segment.uploaded ? segment.byteLength : 0),
		0,
	);
	const uploadedBytes =
		serverPhase !== null && typeof value.uploadedBytes === "number"
			? Math.min(value.totalBytes, Math.max(0, value.uploadedBytes))
			: segmentUploadedBytes;

	return {
		id: value.id,
		shareUrl: value.shareUrl,
		createdAt: value.createdAt,
		status,
		durationSeconds,
		totalBytes: value.totalBytes,
		uploadedBytes,
		segments: parsedSegments,
		uploadOwner,
		serverPhase,
		processingProgress:
			typeof value.processingProgress === "number"
				? Math.min(100, Math.max(0, value.processingProgress))
				: storedStatus === "complete"
					? 100
					: 0,
		processingMessage:
			typeof value.processingMessage === "string"
				? value.processingMessage
				: null,
		error: typeof value.error === "string" ? value.error : null,
		retryCount: value.retryCount,
	};
};

export const hydrateRecordingUploadQueue = (
	value: unknown,
): RecordingUploadQueue => {
	if (!isRecord(value) || !Array.isArray(value.jobs)) {
		return emptyRecordingUploadQueue;
	}
	return {
		jobs: value.jobs
			.map(parseJob)
			.filter((job): job is RecordingUploadJob => job !== null),
	};
};
