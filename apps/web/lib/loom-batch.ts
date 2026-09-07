export const LOOM_BATCH_OPERATION_KIND = "import_loom" as const;
export const MAX_LOOM_BATCH_ROWS = 5_000;
export const MAX_LOOM_BATCH_SOURCE_ROWS = 50_000;
export const MAX_LOOM_BATCH_WORKSPACE_LENGTH = 255;
export const MAX_LOOM_BATCH_PAYLOAD_BYTES = 4 * 1024 * 1024;

export type LoomBatchRowInput = {
	rowNumber: number;
	loomUrl: string;
	userEmail: string;
	spaceName?: string;
};

export type LoomBatchSource = {
	workspace: string;
	from: string;
	to: string;
	totalRows: number;
	omittedRows: number;
};

export type LoomBatchRequest = {
	requestId: string;
	expectedUserId: string;
	expectedDefaultPublic: boolean;
	organizationId: string;
	rows: LoomBatchRowInput[];
	source: LoomBatchSource;
};

export type LoomBatchStartResponse = {
	operationId: string;
	dashboardPath: string;
};

export type LoomBatchStatusState =
	| "queued"
	| "running"
	| "dispatched"
	| "complete"
	| "failed";

export type LoomBatchStatusPhase =
	| "queued"
	| "preparing"
	| "dispatching"
	| "monitoring"
	| "complete"
	| "failed";

export type LoomBatchRowState =
	| "queued"
	| "processing"
	| "ready"
	| "failed"
	| "uncertain";

export type LoomBatchStatusCounts = {
	total: number;
	queued: number;
	processing: number;
	ready: number;
	failed: number;
	uncertain: number;
};

export type LoomBatchStatusRow = {
	rowNumber: number;
	userEmail: string;
	spaceName?: string;
	loomVideoId: string;
	state: LoomBatchRowState;
	videoId?: string;
	error?: string;
	existing?: boolean;
};

export type LoomBatchStatus = {
	operationId: string;
	organizationId: string;
	state: LoomBatchStatusState;
	phase: LoomBatchStatusPhase;
	source: LoomBatchSource;
	counts: LoomBatchStatusCounts;
	currentRowNumber: number | null;
	rows: LoomBatchStatusRow[];
	rowsTruncated: boolean;
	error?: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
};

export type LoomBatchPayloadRow = LoomBatchRowInput & {
	loomVideoId: string;
};

export type LoomBatchPayload = {
	type: "loom_batch";
	version: 1;
	requestId: string;
	requestHash: string;
	organizationId: string;
	requestedByUserId: string;
	defaultPublic: boolean;
	rows: LoomBatchPayloadRow[];
	source: LoomBatchSource;
	createdAt: string;
};

export type LoomBatchParentContext = Pick<
	LoomBatchPayload,
	"requestId" | "organizationId" | "requestedByUserId" | "defaultPublic"
>;

export type LoomBatchChildDispatch = {
	videoId: string;
	ownerId: string;
	rawFileKey: string;
	bucketId: string | null;
	loomVideoId: string;
};

export type LoomBatchChildPayload = {
	type: "loom_child";
	version: 1;
	parentId: string;
	organizationId: string;
	requestedByUserId: string;
	row: Omit<LoomBatchPayloadRow, "loomUrl">;
	dispatch?: LoomBatchChildDispatch;
};

export type LoomBatchChildResult = {
	videoId?: string;
	existing?: boolean;
};

export type LoomBatchProgress = {
	phase: "queued" | "preparing" | "dispatching" | "dispatched";
	totalRows: number;
	preparedRows: number;
	dispatchedRows: number;
	readyRows: number;
	failedRows: number;
	uncertainRows: number;
	currentRowNumber: number | null;
};

export const initialLoomBatchProgress = (
	payload: Pick<LoomBatchPayload, "rows">,
): LoomBatchProgress => ({
	phase: "queued",
	totalRows: payload.rows.length,
	preparedRows: 0,
	dispatchedRows: 0,
	readyRows: 0,
	failedRows: 0,
	uncertainRows: 0,
	currentRowNumber: null,
});

export const mergeLoomBatchProgress = (
	current: LoomBatchProgress,
	next: LoomBatchProgress,
) => {
	if (next.preparedRows < current.preparedRows) return current;
	if (
		next.preparedRows === current.preparedRows &&
		next.dispatchedRows < current.dispatchedRows
	) {
		return current;
	}
	return next;
};

export const isLoomBatchPayload = (
	value: unknown,
): value is LoomBatchPayload => {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<LoomBatchPayload>;
	return (
		payload.type === "loom_batch" &&
		payload.version === 1 &&
		typeof payload.requestId === "string" &&
		typeof payload.requestHash === "string" &&
		/^[0-9a-f]{64}$/.test(payload.requestHash) &&
		typeof payload.organizationId === "string" &&
		typeof payload.requestedByUserId === "string" &&
		typeof payload.defaultPublic === "boolean" &&
		Array.isArray(payload.rows) &&
		payload.rows.length > 0 &&
		payload.rows.length <= MAX_LOOM_BATCH_ROWS &&
		payload.rows.every(
			(row) =>
				row !== null &&
				typeof row === "object" &&
				Number.isInteger(row.rowNumber) &&
				typeof row.loomUrl === "string" &&
				typeof row.loomVideoId === "string" &&
				/^[0-9a-f]{32}$/.test(row.loomVideoId) &&
				typeof row.userEmail === "string" &&
				(row.spaceName === undefined || typeof row.spaceName === "string"),
		) &&
		payload.source !== undefined &&
		payload.source !== null &&
		typeof payload.source === "object" &&
		typeof payload.source.workspace === "string" &&
		typeof payload.source.from === "string" &&
		typeof payload.source.to === "string" &&
		Number.isInteger(payload.source.totalRows) &&
		Number.isInteger(payload.source.omittedRows) &&
		typeof payload.createdAt === "string"
	);
};

export const isLoomBatchChildPayload = (
	value: unknown,
): value is LoomBatchChildPayload => {
	if (!value || typeof value !== "object") return false;
	const payload = value as Partial<LoomBatchChildPayload>;
	const row = payload.row;
	return (
		payload.type === "loom_child" &&
		payload.version === 1 &&
		typeof payload.parentId === "string" &&
		typeof payload.organizationId === "string" &&
		typeof payload.requestedByUserId === "string" &&
		row !== undefined &&
		row !== null &&
		typeof row === "object" &&
		Number.isInteger(row.rowNumber) &&
		typeof row.loomVideoId === "string" &&
		/^[0-9a-f]{32}$/.test(row.loomVideoId) &&
		typeof row.userEmail === "string" &&
		(row.spaceName === undefined || typeof row.spaceName === "string") &&
		(payload.dispatch === undefined ||
			(payload.dispatch !== null &&
				typeof payload.dispatch === "object" &&
				typeof payload.dispatch.videoId === "string" &&
				typeof payload.dispatch.ownerId === "string" &&
				typeof payload.dispatch.rawFileKey === "string" &&
				(payload.dispatch.bucketId === null ||
					typeof payload.dispatch.bucketId === "string") &&
				typeof payload.dispatch.loomVideoId === "string" &&
				payload.dispatch.loomVideoId === row.loomVideoId))
	);
};

export const isLoomBatchProgress = (
	value: unknown,
): value is LoomBatchProgress => {
	if (!value || typeof value !== "object") return false;
	const progress = value as Partial<LoomBatchProgress>;
	return (
		progress.phase !== undefined &&
		["queued", "preparing", "dispatching", "dispatched"].includes(
			progress.phase,
		) &&
		Number.isInteger(progress.totalRows) &&
		Number.isInteger(progress.preparedRows) &&
		Number.isInteger(progress.dispatchedRows) &&
		Number.isInteger(progress.readyRows) &&
		Number.isInteger(progress.failedRows) &&
		Number.isInteger(progress.uncertainRows) &&
		(progress.currentRowNumber === null ||
			Number.isInteger(progress.currentRowNumber))
	);
};
