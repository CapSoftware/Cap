export type RecordingUploadStatus =
	| "recording"
	| "uploading"
	| "processing"
	| "failed"
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
	segments: RecordingUploadSegment[];
	error: string | null;
	retryCount: number;
};

export type RecordingUploadQueue = {
	jobs: RecordingUploadJob[];
};

export type RecordingUploadQueueAction =
	| { type: "begin"; id: string; shareUrl: string }
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
	| { type: "processing"; id: string }
	| { type: "complete"; id: string }
	| { type: "fail"; id: string; error: string }
	| { type: "retry"; id: string }
	| { type: "remove"; id: string };

export const emptyRecordingUploadQueue: RecordingUploadQueue = { jobs: [] };

const updateJob = (
	queue: RecordingUploadQueue,
	id: string,
	update: (job: RecordingUploadJob) => RecordingUploadJob,
): RecordingUploadQueue => ({
	jobs: queue.jobs.map((job) => (job.id === id ? update(job) : job)),
});

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
						segments: [],
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
			}));
		case "segmentUploaded":
			return updateJob(queue, action.id, (job) => ({
				...job,
				segments: job.segments.map((segment) =>
					segment.track === action.track &&
					segment.type === action.segmentType &&
					segment.index === action.index
						? { ...segment, uploaded: true }
						: segment,
				),
			}));
		case "processing":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: "processing",
				error: null,
			}));
		case "complete":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: "complete",
				error: null,
			}));
		case "fail":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: "failed",
				error: action.error,
				retryCount: job.retryCount + 1,
			}));
		case "retry":
			return updateJob(queue, action.id, (job) => ({
				...job,
				status: job.durationSeconds === null ? "recording" : "uploading",
				error: null,
			}));
		case "remove":
			return { jobs: queue.jobs.filter((job) => job.id !== action.id) };
	}
};

export const recordingUploadProgress = (job: RecordingUploadJob) => {
	if (job.totalBytes <= 0) return 0;
	const uploadedBytes = job.segments.reduce(
		(total, segment) => total + (segment.uploaded ? segment.byteLength : 0),
		0,
	);
	return Math.min(1, Math.max(0, uploadedBytes / job.totalBytes));
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
			: storedStatus === "failed" && durationSeconds === null
				? "failed"
				: durationSeconds === null
					? "recording"
					: "uploading";

	return {
		id: value.id,
		shareUrl: value.shareUrl,
		createdAt: value.createdAt,
		status,
		durationSeconds,
		totalBytes: value.totalBytes,
		segments: parsedSegments,
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
