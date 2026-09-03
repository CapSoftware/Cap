import "server-only";

import { createHash } from "node:crypto";
import { db } from "@cap/database";
import * as Db from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { type DbClient, Storage } from "@cap/web-backend";
import { Organisation, Space, User, Video } from "@cap/web-domain";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { Option } from "effect";
import { start } from "workflow/api";
import {
	authorizeExtensionLoomImport,
	canonicalizeExtensionLoomUrl,
	ExtensionLoomAuthorizationError,
	validateExtensionLoomRow,
} from "@/lib/extension-loom-import";
import {
	initialLoomBatchProgress,
	isLoomBatchChildPayload,
	isLoomBatchPayload,
	isLoomBatchProgress,
	LOOM_BATCH_OPERATION_KIND,
	type LoomBatchChildPayload,
	type LoomBatchChildResult,
	type LoomBatchParentContext,
	type LoomBatchPayload,
	type LoomBatchPayloadRow,
	type LoomBatchProgress,
	type LoomBatchRequest,
	type LoomBatchSource,
	type LoomBatchStartResponse,
	type LoomBatchStatus,
	type LoomBatchStatusRow,
	MAX_LOOM_BATCH_PAYLOAD_BYTES,
	MAX_LOOM_BATCH_ROWS,
	MAX_LOOM_BATCH_SOURCE_ROWS,
	MAX_LOOM_BATCH_WORKSPACE_LENGTH,
	mergeLoomBatchProgress,
} from "@/lib/loom-batch";
import { downloadLoomVideo } from "@/lib/loom-import";
import { provisionOrganizationInvitee } from "@/lib/organization-provisioning";
import { runWorkflowPromise } from "@/lib/workflow-runtime";
import { importLoomVideoWorkflow } from "@/workflows/import-loom-video";

type TransactionCallback = Parameters<DbClient["transaction"]>[0];
type Transaction = Parameters<TransactionCallback>[0];

type ChildOperation = Pick<
	typeof Db.agentApiOperations.$inferSelect,
	| "id"
	| "userId"
	| "resourceId"
	| "state"
	| "payload"
	| "result"
	| "resultResourceId"
	| "errorCode"
	| "errorMessage"
>;

export type LoomBatchPreparation = {
	childOperationId: string;
	state: "dispatch" | "processing" | "ready" | "failed" | "uncertain";
};

export class LoomBatchValidationError extends Error {}
export class LoomBatchConflictError extends Error {}
export class LoomBatchNotFoundError extends Error {}

const UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const hashHex = (value: string) =>
	createHash("sha256").update(value, "utf8").digest("hex");

const deterministicId = (namespace: string, ...parts: string[]) =>
	createHash("sha256")
		.update([namespace, ...parts].join("\0"), "utf8")
		.digest("base64url")
		.slice(0, 15);

export const getLoomBatchOperationId = (
	userId: string,
	organizationId: string,
	requestId: string,
) => deterministicId("loom_batch", userId, organizationId, requestId);

export const getLoomBatchChildOperationId = (
	parentId: string,
	loomVideoId: string,
) => deterministicId("loom_batch_child", parentId, loomVideoId);

export const shouldStartLoomBatchParent = (
	state: typeof Db.agentApiOperations.$inferSelect.state | undefined,
) => state === undefined || state === "queued";

const isCalendarDate = (value: string) => {
	if (!DATE_PATTERN.test(value)) return false;
	const parsed = new Date(`${value}T00:00:00.000Z`);
	return (
		!Number.isNaN(parsed.getTime()) &&
		parsed.toISOString().slice(0, 10) === value
	);
};

const normalizeSpaceName = (value: string | undefined) => {
	const normalized = value?.trim().replace(/\s+/g, " ") ?? "";
	return normalized || undefined;
};

const extractCanonicalLoomId = (loomUrl: string) =>
	loomUrl.slice(loomUrl.lastIndexOf("/") + 1);

export function normalizeLoomBatchRequest(
	request: LoomBatchRequest,
	currentUserId: string,
): LoomBatchPayload {
	if (request.expectedUserId !== currentUserId) {
		throw new ExtensionLoomAuthorizationError();
	}
	if (typeof request.expectedDefaultPublic !== "boolean") {
		throw new LoomBatchValidationError("Expected visibility is invalid.");
	}
	if (!UUID_PATTERN.test(request.requestId)) {
		throw new LoomBatchValidationError("Request ID must be a UUID.");
	}
	if (
		!Array.isArray(request.rows) ||
		request.rows.length === 0 ||
		request.rows.length > MAX_LOOM_BATCH_ROWS
	) {
		throw new LoomBatchValidationError(
			`A Loom batch must contain between 1 and ${MAX_LOOM_BATCH_ROWS} rows.`,
		);
	}
	if (
		!request.source ||
		typeof request.source.workspace !== "string" ||
		request.source.workspace.trim().length === 0 ||
		request.source.workspace.trim().length > MAX_LOOM_BATCH_WORKSPACE_LENGTH ||
		!isCalendarDate(request.source.from) ||
		!isCalendarDate(request.source.to) ||
		request.source.from > request.source.to ||
		!Number.isInteger(request.source.totalRows) ||
		request.source.totalRows < 1 ||
		request.source.totalRows > MAX_LOOM_BATCH_SOURCE_ROWS ||
		!Number.isInteger(request.source.omittedRows) ||
		request.source.omittedRows < 0 ||
		request.source.totalRows !==
			request.rows.length + request.source.omittedRows
	) {
		throw new LoomBatchValidationError("Loom source metadata is invalid.");
	}

	const rows: LoomBatchPayloadRow[] = [];
	const seenVideoIds = new Set<string>();
	for (const input of request.rows) {
		const row = {
			rowNumber: input.rowNumber,
			loomUrl: typeof input.loomUrl === "string" ? input.loomUrl.trim() : "",
			userEmail:
				typeof input.userEmail === "string"
					? input.userEmail.trim().toLowerCase()
					: "",
			spaceName:
				typeof input.spaceName === "string"
					? normalizeSpaceName(input.spaceName)
					: undefined,
		};
		const validationError = validateExtensionLoomRow(row);
		if (validationError) throw new LoomBatchValidationError(validationError);
		const canonicalLoomUrl = canonicalizeExtensionLoomUrl(row.loomUrl);
		if (!canonicalLoomUrl) {
			throw new LoomBatchValidationError("Loom URL is invalid.");
		}
		const loomVideoId = extractCanonicalLoomId(canonicalLoomUrl);
		if (seenVideoIds.has(loomVideoId)) continue;
		seenVideoIds.add(loomVideoId);
		rows.push({ ...row, loomUrl: canonicalLoomUrl, loomVideoId });
	}
	if (rows.length === 0) {
		throw new LoomBatchValidationError(
			"The Loom batch contains no unique videos.",
		);
	}

	const source: LoomBatchSource = {
		workspace: request.source.workspace.trim(),
		from: request.source.from,
		to: request.source.to,
		totalRows: request.source.totalRows,
		omittedRows:
			request.source.omittedRows + (request.rows.length - rows.length),
	};
	const normalizedRequest = {
		requestId: request.requestId.toLowerCase(),
		expectedUserId: currentUserId,
		expectedDefaultPublic: request.expectedDefaultPublic,
		organizationId: request.organizationId,
		rows,
		source,
	};
	const requestHash = hashHex(JSON.stringify(normalizedRequest));
	const payload: LoomBatchPayload = {
		type: "loom_batch",
		version: 1,
		requestId: normalizedRequest.requestId,
		requestHash,
		organizationId: request.organizationId,
		requestedByUserId: currentUserId,
		defaultPublic: request.expectedDefaultPublic,
		rows,
		source,
		createdAt: new Date().toISOString(),
	};
	if (
		Buffer.byteLength(JSON.stringify(payload), "utf8") >
		MAX_LOOM_BATCH_PAYLOAD_BYTES
	) {
		throw new LoomBatchValidationError("The Loom batch payload is too large.");
	}
	return payload;
}

const initialRunningProgress = (
	payload: LoomBatchPayload,
): LoomBatchProgress => ({
	...initialLoomBatchProgress(payload),
	phase: "preparing",
});

const assertMatchingParent = (
	operation: Pick<
		typeof Db.agentApiOperations.$inferSelect,
		"userId" | "resourceId" | "payload"
	>,
	payload: LoomBatchPayload,
) => {
	if (
		operation.userId !== payload.requestedByUserId ||
		operation.resourceId !== payload.organizationId ||
		!isLoomBatchPayload(operation.payload) ||
		operation.payload.requestHash !== payload.requestHash
	) {
		throw new LoomBatchConflictError(
			"Request ID was already used for a different Loom batch.",
		);
	}
};

export async function startLoomBatchImport({
	request,
	currentUserId,
	startBatchWorkflow,
}: {
	request: LoomBatchRequest;
	currentUserId: User.UserId;
	startBatchWorkflow: (operationId: string) => Promise<void>;
}): Promise<LoomBatchStartResponse> {
	const organizationId = Organisation.OrganisationId.make(
		request.organizationId,
	);
	const payload = normalizeLoomBatchRequest(request, currentUserId);
	if (serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC !== payload.defaultPublic) {
		throw new LoomBatchConflictError(
			"Cap visibility changed. Refresh the import setup and try again.",
		);
	}
	await authorizeExtensionLoomImport({
		userId: currentUserId,
		organizationId,
	});
	const operationId = getLoomBatchOperationId(
		currentUserId,
		organizationId,
		payload.requestId,
	);
	const progress = initialLoomBatchProgress(payload);

	const shouldStartParent = await db().transaction(async (tx) => {
		const [organization] = await tx
			.select({ id: Db.organizations.id })
			.from(Db.organizations)
			.where(
				and(
					eq(Db.organizations.id, organizationId),
					isNull(Db.organizations.tombstoneAt),
				),
			)
			.limit(1)
			.for("update");
		if (!organization) throw new ExtensionLoomAuthorizationError();

		const [existing] = await tx
			.select({
				userId: Db.agentApiOperations.userId,
				resourceId: Db.agentApiOperations.resourceId,
				payload: Db.agentApiOperations.payload,
				state: Db.agentApiOperations.state,
			})
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (existing) {
			assertMatchingParent(existing, payload);
			return shouldStartLoomBatchParent(existing.state);
		}

		const activeOperations = await tx
			.select({ payload: Db.agentApiOperations.payload })
			.from(Db.agentApiOperations)
			.where(
				and(
					eq(Db.agentApiOperations.kind, LOOM_BATCH_OPERATION_KIND),
					eq(Db.agentApiOperations.resourceId, organizationId),
					inArray(Db.agentApiOperations.state, ["queued", "running"]),
				),
			)
			.for("update");
		if (
			activeOperations.some((operation) =>
				isLoomBatchPayload(operation.payload),
			)
		) {
			throw new LoomBatchConflictError(
				"Another Loom batch is already being prepared for this organization.",
			);
		}

		await tx.insert(Db.agentApiOperations).values({
			id: operationId,
			userId: currentUserId,
			kind: LOOM_BATCH_OPERATION_KIND,
			resourceId: organizationId,
			state: "queued",
			payload,
			result: progress,
		});
		return true;
	});

	if (shouldStartParent) await startBatchWorkflow(operationId);

	return {
		operationId,
		dashboardPath: `/dashboard/import/loom/status?operationId=${encodeURIComponent(operationId)}&organizationId=${encodeURIComponent(organizationId)}`,
	};
}

const assertChildScope = (
	operation: ChildOperation,
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
) => {
	if (
		operation.userId !== parent.requestedByUserId ||
		operation.resourceId !== parent.organizationId ||
		!isLoomBatchChildPayload(operation.payload) ||
		operation.payload.parentId !==
			getLoomBatchOperationId(
				parent.requestedByUserId,
				parent.organizationId,
				parent.requestId,
			) ||
		operation.payload.row.rowNumber !== row.rowNumber ||
		operation.payload.row.loomVideoId !== row.loomVideoId ||
		operation.payload.row.userEmail !== row.userEmail ||
		operation.payload.row.spaceName !== row.spaceName
	) {
		throw new LoomBatchConflictError("Loom batch child operation is invalid.");
	}
};

const preparationFromChild = (
	operation: ChildOperation,
): LoomBatchPreparation => {
	if (operation.state === "queued") {
		return {
			childOperationId: operation.id,
			state:
				isLoomBatchChildPayload(operation.payload) && operation.payload.dispatch
					? "dispatch"
					: "uncertain",
		};
	}
	if (operation.state === "running") {
		return { childOperationId: operation.id, state: "processing" };
	}
	if (operation.state === "succeeded") {
		return { childOperationId: operation.id, state: "ready" };
	}
	return {
		childOperationId: operation.id,
		state:
			operation.errorCode === "LOOM_IMPORT_UNCERTAIN" ? "uncertain" : "failed",
	};
};

const getChildOperation = async (childOperationId: string) => {
	const [operation] = await db()
		.select({
			id: Db.agentApiOperations.id,
			userId: Db.agentApiOperations.userId,
			resourceId: Db.agentApiOperations.resourceId,
			state: Db.agentApiOperations.state,
			payload: Db.agentApiOperations.payload,
			result: Db.agentApiOperations.result,
			resultResourceId: Db.agentApiOperations.resultResourceId,
			errorCode: Db.agentApiOperations.errorCode,
			errorMessage: Db.agentApiOperations.errorMessage,
		})
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, childOperationId))
		.limit(1);
	return operation;
};

const childPayload = (
	parentId: string,
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
	dispatch?: LoomBatchChildPayload["dispatch"],
): LoomBatchChildPayload => ({
	type: "loom_child",
	version: 1,
	parentId,
	organizationId: parent.organizationId,
	requestedByUserId: parent.requestedByUserId,
	row: {
		rowNumber: row.rowNumber,
		loomVideoId: row.loomVideoId,
		userEmail: row.userEmail,
		...(row.spaceName ? { spaceName: row.spaceName } : {}),
	},
	...(dispatch ? { dispatch } : {}),
});

const getExistingImport = (
	tx: Transaction,
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
) =>
	tx
		.select({
			mappingId: Db.importedVideos.id,
			videoId: Db.videos.id,
			uploadPhase: Db.videoUploads.phase,
		})
		.from(Db.importedVideos)
		.leftJoin(
			Db.videos,
			and(
				eq(Db.videos.id, Db.importedVideos.id),
				eq(Db.videos.orgId, Db.importedVideos.orgId),
			),
		)
		.leftJoin(Db.videoUploads, eq(Db.videoUploads.videoId, Db.videos.id))
		.where(
			and(
				eq(
					Db.importedVideos.orgId,
					Organisation.OrganisationId.make(parent.organizationId),
				),
				eq(Db.importedVideos.source, "loom"),
				eq(Db.importedVideos.sourceId, row.loomVideoId),
			),
		)
		.limit(1)
		.for("update");

const insertTerminalChild = async ({
	tx,
	childOperationId,
	parentId,
	parent,
	row,
	state,
	videoId,
	error,
}: {
	tx: Transaction;
	childOperationId: string;
	parentId: string;
	parent: LoomBatchParentContext;
	row: LoomBatchPayloadRow;
	state: "ready" | "failed" | "uncertain";
	videoId?: string;
	error?: string;
}) => {
	const now = new Date();
	const result: LoomBatchChildResult | null =
		state === "ready" && videoId ? { videoId, existing: true } : null;
	await tx.insert(Db.agentApiOperations).values({
		id: childOperationId,
		userId: User.UserId.make(parent.requestedByUserId),
		kind: LOOM_BATCH_OPERATION_KIND,
		resourceId: Organisation.OrganisationId.make(parent.organizationId),
		resultResourceId: videoId ? Video.VideoId.make(videoId) : null,
		state: state === "ready" ? "succeeded" : "failed",
		payload: childPayload(parentId, parent, row),
		result,
		errorCode:
			state === "uncertain"
				? "LOOM_IMPORT_UNCERTAIN"
				: state === "failed"
					? "LOOM_IMPORT_PREPARATION_FAILED"
					: null,
		errorMessage: error?.slice(0, 2_000) ?? null,
		updatedAt: now,
		completedAt: now,
	});
	return { childOperationId, state } satisfies LoomBatchPreparation;
};

const recordTerminalChild = async ({
	parentId,
	parent,
	row,
	fallbackState,
	error,
}: {
	parentId: string;
	parent: LoomBatchParentContext;
	row: LoomBatchPayloadRow;
	fallbackState: "failed" | "uncertain";
	error: string;
}): Promise<LoomBatchPreparation> => {
	const childOperationId = getLoomBatchChildOperationId(
		parentId,
		row.loomVideoId,
	);
	try {
		return await db().transaction(async (tx) => {
			const [existingChild] = await tx
				.select({
					id: Db.agentApiOperations.id,
					userId: Db.agentApiOperations.userId,
					resourceId: Db.agentApiOperations.resourceId,
					state: Db.agentApiOperations.state,
					payload: Db.agentApiOperations.payload,
					result: Db.agentApiOperations.result,
					resultResourceId: Db.agentApiOperations.resultResourceId,
					errorCode: Db.agentApiOperations.errorCode,
					errorMessage: Db.agentApiOperations.errorMessage,
				})
				.from(Db.agentApiOperations)
				.where(eq(Db.agentApiOperations.id, childOperationId))
				.limit(1)
				.for("update");
			if (existingChild) {
				assertChildScope(existingChild, parent, row);
				return preparationFromChild(existingChild);
			}
			const [existingImport] = await getExistingImport(tx, parent, row);
			if (existingImport) {
				if (
					existingImport.videoId &&
					(existingImport.uploadPhase === null ||
						existingImport.uploadPhase === "complete")
				) {
					return insertTerminalChild({
						tx,
						childOperationId,
						parentId,
						parent,
						row,
						state: "ready",
						videoId: existingImport.videoId,
					});
				}
				return insertTerminalChild({
					tx,
					childOperationId,
					parentId,
					parent,
					row,
					state: "uncertain",
					videoId: existingImport.videoId ?? undefined,
					error:
						"A Loom source mapping already exists, but its import is not complete.",
				});
			}
			return insertTerminalChild({
				tx,
				childOperationId,
				parentId,
				parent,
				row,
				state: fallbackState,
				error,
			});
		});
	} catch (cause) {
		const existingChild = await getChildOperation(childOperationId);
		if (!existingChild) throw cause;
		assertChildScope(existingChild, parent, row);
		return preparationFromChild(existingChild);
	}
};

const getOrganizationOwnerByEmail = async (
	organizationId: Organisation.OrganisationId,
	email: string,
) => {
	const [member] = await db()
		.select({ id: Db.users.id })
		.from(Db.users)
		.innerJoin(Db.organizations, eq(Db.organizations.id, organizationId))
		.leftJoin(
			Db.organizationMembers,
			and(
				eq(Db.organizationMembers.organizationId, organizationId),
				eq(Db.organizationMembers.userId, Db.users.id),
			),
		)
		.where(
			and(
				eq(Db.users.email, email),
				or(
					eq(Db.organizations.ownerId, Db.users.id),
					eq(Db.organizationMembers.userId, Db.users.id),
				),
			),
		)
		.limit(1);
	return member?.id;
};

const getOrProvisionOwner = async (
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
) => {
	const organizationId = Organisation.OrganisationId.make(
		parent.organizationId,
	);
	const existing = await getOrganizationOwnerByEmail(
		organizationId,
		row.userEmail,
	);
	if (existing) return existing;
	const provisioned = await provisionOrganizationInvitee({
		organizationId,
		email: row.userEmail,
		invitedByUserId: User.UserId.make(parent.requestedByUserId),
		role: "member",
	});
	return provisioned.userId;
};

const insertSpacePlacement = async ({
	tx,
	parent,
	row,
	ownerId,
	videoId,
}: {
	tx: Transaction;
	parent: LoomBatchParentContext;
	row: LoomBatchPayloadRow;
	ownerId: User.UserId;
	videoId: Video.VideoId;
}) => {
	if (!row.spaceName) return;
	const organizationId = Organisation.OrganisationId.make(
		parent.organizationId,
	);
	const normalizedName = row.spaceName;
	const [existingSpace] = await tx
		.select({ id: Db.spaces.id })
		.from(Db.spaces)
		.where(
			and(
				eq(Db.spaces.organizationId, organizationId),
				sql`LOWER(${Db.spaces.name}) = ${normalizedName.toLowerCase()}`,
			),
		)
		.limit(1);
	const spaceId =
		existingSpace?.id ??
		Space.SpaceId.make(
			deterministicId(
				"loom_batch_space",
				parent.organizationId,
				normalizedName.toLowerCase(),
			),
		);
	if (!existingSpace) {
		await tx.insert(Db.spaces).values({
			id: spaceId,
			name: normalizedName,
			organizationId,
			createdById: User.UserId.make(parent.requestedByUserId),
			iconUrl: null,
		});
	}
	for (const [userId, role] of [
		[User.UserId.make(parent.requestedByUserId), "admin"],
		[ownerId, ownerId === parent.requestedByUserId ? "admin" : "member"],
	] as const) {
		await tx
			.insert(Db.spaceMembers)
			.values({
				id: deterministicId("loom_batch_space_member", spaceId, userId),
				spaceId,
				userId,
				role,
			})
			.onDuplicateKeyUpdate({
				set: { role: sql`${Db.spaceMembers.role}` },
			});
	}
	await tx
		.insert(Db.spaceVideos)
		.values({
			id: deterministicId("loom_batch_space_video", spaceId, videoId),
			spaceId,
			videoId,
			addedById: User.UserId.make(parent.requestedByUserId),
		})
		.onDuplicateKeyUpdate({
			set: { id: sql`${Db.spaceVideos.id}` },
		});
};

export async function prepareLoomBatchRow(
	parentId: string,
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
): Promise<LoomBatchPreparation> {
	const childOperationId = getLoomBatchChildOperationId(
		parentId,
		row.loomVideoId,
	);
	const existingChild = await getChildOperation(childOperationId);
	if (existingChild) {
		assertChildScope(existingChild, parent, row);
		return preparationFromChild(existingChild);
	}

	const [existingImport] = await db().transaction((tx) =>
		getExistingImport(tx, parent, row),
	);
	if (existingImport) {
		return recordTerminalChild({
			parentId,
			parent,
			row,
			fallbackState: "uncertain",
			error:
				"A Loom source mapping already exists, but its import is not complete.",
		});
	}

	const download = await downloadLoomVideo(row.loomUrl);
	if (
		!download.success ||
		!download.videoId ||
		download.videoId !== row.loomVideoId
	) {
		return recordTerminalChild({
			parentId,
			parent,
			row,
			fallbackState: "failed",
			error: download.error ?? "The Loom video could not be prepared.",
		});
	}

	let ownerId: User.UserId;
	try {
		ownerId = await getOrProvisionOwner(parent, row);
	} catch {
		return recordTerminalChild({
			parentId,
			parent,
			row,
			fallbackState: "failed",
			error: "Could not add this email to the organization.",
		});
	}

	const organizationId = Organisation.OrganisationId.make(
		parent.organizationId,
	);
	const writableResult = await Storage.getWritableAccessForUser(
		ownerId,
		organizationId,
	)
		.pipe(runWorkflowPromise)
		.then(
			(value) => ({ ok: true as const, value }),
			() => ({ ok: false as const }),
		);
	if (!writableResult.ok) {
		return recordTerminalChild({
			parentId,
			parent,
			row,
			fallbackState: "failed",
			error: "Could not prepare storage for this import.",
		});
	}

	const videoId = Video.VideoId.make(
		deterministicId("loom_batch_video", childOperationId),
	);
	const rawFileKey = `${ownerId}/${videoId}/raw-upload.mp4`;
	const dispatch = {
		videoId,
		ownerId,
		rawFileKey,
		bucketId: Option.getOrNull(writableResult.value.bucketId),
		loomVideoId: row.loomVideoId,
	};

	try {
		return await db().transaction(async (tx) => {
			const [operation] = await tx
				.select({
					id: Db.agentApiOperations.id,
					userId: Db.agentApiOperations.userId,
					resourceId: Db.agentApiOperations.resourceId,
					state: Db.agentApiOperations.state,
					payload: Db.agentApiOperations.payload,
					result: Db.agentApiOperations.result,
					resultResourceId: Db.agentApiOperations.resultResourceId,
					errorCode: Db.agentApiOperations.errorCode,
					errorMessage: Db.agentApiOperations.errorMessage,
				})
				.from(Db.agentApiOperations)
				.where(eq(Db.agentApiOperations.id, childOperationId))
				.limit(1)
				.for("update");
			if (operation) {
				assertChildScope(operation, parent, row);
				return preparationFromChild(operation);
			}
			const [mapping] = await getExistingImport(tx, parent, row);
			if (mapping) {
				if (
					mapping.videoId &&
					(mapping.uploadPhase === null || mapping.uploadPhase === "complete")
				) {
					return insertTerminalChild({
						tx,
						childOperationId,
						parentId,
						parent,
						row,
						state: "ready",
						videoId: mapping.videoId,
					});
				}
				return insertTerminalChild({
					tx,
					childOperationId,
					parentId,
					parent,
					row,
					state: "uncertain",
					videoId: mapping.videoId ?? undefined,
					error:
						"A Loom source mapping already exists, but its import is not complete.",
				});
			}

			await tx.insert(Db.videos).values({
				id: videoId,
				name:
					download.videoName?.slice(0, 255) ??
					`Loom Import - ${new Date().toISOString().slice(0, 10)}`,
				ownerId,
				orgId: organizationId,
				source: { type: "webMP4" },
				bucket: dispatch.bucketId,
				storageIntegrationId: Option.getOrNull(
					writableResult.value.storageIntegrationId,
				),
				public: parent.defaultPublic,
				duration: download.durationSeconds,
				width: download.width,
				height: download.height,
			});
			await tx.insert(Db.videoUploads).values({
				videoId,
				phase: "uploading",
				processingProgress: 0,
				processingMessage: "Importing from Loom...",
			});
			await tx.insert(Db.importedVideos).values({
				id: videoId,
				orgId: organizationId,
				source: "loom",
				sourceId: row.loomVideoId,
			});
			await insertSpacePlacement({ tx, parent, row, ownerId, videoId });
			await tx.insert(Db.agentApiOperations).values({
				id: childOperationId,
				userId: User.UserId.make(parent.requestedByUserId),
				kind: LOOM_BATCH_OPERATION_KIND,
				resourceId: organizationId,
				resultResourceId: videoId,
				state: "queued",
				payload: childPayload(parentId, parent, row, dispatch),
			});
			return {
				childOperationId,
				state: "dispatch",
			} satisfies LoomBatchPreparation;
		});
	} catch (cause) {
		const concurrentChild = await getChildOperation(childOperationId);
		if (concurrentChild) {
			assertChildScope(concurrentChild, parent, row);
			return preparationFromChild(concurrentChild);
		}
		const [concurrentMapping] = await db().transaction((tx) =>
			getExistingImport(tx, parent, row),
		);
		if (concurrentMapping) {
			return recordTerminalChild({
				parentId,
				parent,
				row,
				fallbackState: "uncertain",
				error:
					"A Loom source mapping was created concurrently without a durable batch outcome.",
			});
		}
		throw cause;
	}
}

export async function claimLoomBatchOperation(operationId: string) {
	const [operation] = await db()
		.select()
		.from(Db.agentApiOperations)
		.where(eq(Db.agentApiOperations.id, operationId))
		.limit(1);
	if (!operation || !isLoomBatchPayload(operation.payload)) {
		throw new LoomBatchNotFoundError("Loom batch operation was not found.");
	}
	const payload = operation.payload;
	await authorizeExtensionLoomImport({
		userId: User.UserId.make(payload.requestedByUserId),
		organizationId: Organisation.OrganisationId.make(payload.organizationId),
	});

	return db().transaction(async (tx) => {
		const [locked] = await tx
			.select()
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (
			!locked ||
			!isLoomBatchPayload(locked.payload) ||
			locked.userId !== locked.payload.requestedByUserId ||
			locked.resourceId !== locked.payload.organizationId
		) {
			throw new LoomBatchConflictError(
				"Loom batch operation scope is invalid.",
			);
		}
		if (locked.state === "succeeded" || locked.state === "failed") return null;
		if (locked.state === "running") {
			const progress = isLoomBatchProgress(locked.result)
				? locked.result
				: initialRunningProgress(locked.payload);
			return { payload: locked.payload, progress };
		}
		const progress = initialRunningProgress(locked.payload);
		await tx
			.update(Db.agentApiOperations)
			.set({ state: "running", result: progress, updatedAt: new Date() })
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.state, "queued"),
				),
			);
		return { payload: locked.payload, progress };
	});
}

export async function setLoomBatchProgress(
	operationId: string,
	progress: LoomBatchProgress,
) {
	await db().transaction(async (tx) => {
		const [operation] = await tx
			.select({
				state: Db.agentApiOperations.state,
				result: Db.agentApiOperations.result,
			})
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (!operation || operation.state !== "running") {
			throw new LoomBatchConflictError("Loom batch is no longer running.");
		}
		const nextProgress = isLoomBatchProgress(operation.result)
			? mergeLoomBatchProgress(operation.result, progress)
			: progress;
		await tx
			.update(Db.agentApiOperations)
			.set({ result: nextProgress, updatedAt: new Date() })
			.where(eq(Db.agentApiOperations.id, operationId));
	});
}

export async function dispatchLoomBatchChild(childOperationId: string) {
	const operation = await getChildOperation(childOperationId);
	if (!operation || !isLoomBatchChildPayload(operation.payload)) {
		throw new LoomBatchConflictError(
			"Loom batch child operation was not found.",
		);
	}
	if (operation.state !== "queued") return false;
	const dispatch = operation.payload.dispatch;
	if (!dispatch) {
		throw new LoomBatchConflictError("Loom batch child is not dispatchable.");
	}
	await start(importLoomVideoWorkflow, [
		{
			videoId: dispatch.videoId,
			userId: dispatch.ownerId,
			rawFileKey: dispatch.rawFileKey,
			bucketId: dispatch.bucketId,
			loomVideoId: dispatch.loomVideoId,
			agentOperationId: childOperationId,
		},
	]);
	return true;
}

export async function completeLoomBatchOperation(
	operationId: string,
	progress: LoomBatchProgress,
) {
	await db().transaction(async (tx) => {
		const [operation] = await tx
			.select({
				state: Db.agentApiOperations.state,
				result: Db.agentApiOperations.result,
			})
			.from(Db.agentApiOperations)
			.where(eq(Db.agentApiOperations.id, operationId))
			.limit(1)
			.for("update");
		if (!operation || operation.state !== "running") return;
		const mergedProgress = isLoomBatchProgress(operation.result)
			? mergeLoomBatchProgress(operation.result, progress)
			: progress;
		const now = new Date();
		await tx
			.update(Db.agentApiOperations)
			.set({
				state: "succeeded",
				result: {
					...mergedProgress,
					phase: "dispatched",
					currentRowNumber: null,
				},
				errorCode: null,
				errorMessage: null,
				updatedAt: now,
				completedAt: now,
			})
			.where(
				and(
					eq(Db.agentApiOperations.id, operationId),
					eq(Db.agentApiOperations.state, "running"),
				),
			);
	});
}

export async function failLoomBatchOperation(
	operationId: string,
	error: unknown,
) {
	const now = new Date();
	await db()
		.update(Db.agentApiOperations)
		.set({
			state: "failed",
			errorCode: "LOOM_BATCH_FAILED",
			errorMessage:
				error instanceof Error
					? error.message.slice(0, 2_000)
					: "Loom batch failed.",
			updatedAt: now,
			completedAt: now,
		})
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				inArray(Db.agentApiOperations.state, ["queued", "running"]),
			),
		);
}

type ChildStatusRecord = ChildOperation & {
	videoId: string | null;
	uploadPhase: typeof Db.videoUploads.$inferSelect.phase | null;
	uploadError: string | null;
};

const statusRowFromChild = (
	parent: LoomBatchPayload,
	row: LoomBatchPayloadRow,
	operation: ChildStatusRecord | undefined,
	parentState: typeof Db.agentApiOperations.$inferSelect.state,
): LoomBatchStatusRow => {
	const base = {
		rowNumber: row.rowNumber,
		userEmail: row.userEmail,
		...(row.spaceName ? { spaceName: row.spaceName } : {}),
		loomVideoId: row.loomVideoId,
	};
	if (!operation) {
		if (parentState === "failed") {
			return {
				...base,
				state: "uncertain",
				error: "Batch stopped before a durable outcome was recorded.",
			};
		}
		if (parentState === "succeeded") {
			return {
				...base,
				state: "uncertain",
				error: "No durable outcome was recorded for this row.",
			};
		}
		return { ...base, state: "queued" };
	}
	try {
		assertChildScope(operation, parent, row);
	} catch {
		return {
			...base,
			state: "uncertain",
			error: "The durable row outcome does not match this batch.",
		};
	}
	const childResult =
		operation.result && typeof operation.result === "object"
			? (operation.result as LoomBatchChildResult)
			: undefined;
	const retainedVideoId = operation.videoId ?? childResult?.videoId;
	if (operation.state === "failed") {
		return {
			...base,
			state:
				operation.errorCode === "LOOM_IMPORT_UNCERTAIN"
					? "uncertain"
					: "failed",
			...(retainedVideoId ? { videoId: retainedVideoId } : {}),
			...(operation.errorMessage ? { error: operation.errorMessage } : {}),
		};
	}
	if (operation.state === "succeeded") {
		if (
			operation.videoId &&
			(operation.uploadPhase === null || operation.uploadPhase === "complete")
		) {
			return {
				...base,
				state: "ready",
				videoId: operation.videoId,
				...(childResult?.existing ? { existing: true } : {}),
			};
		}
		return {
			...base,
			state: "uncertain",
			...(retainedVideoId ? { videoId: retainedVideoId } : {}),
			error: "The row completed without a completed Cap upload.",
		};
	}
	if (operation.uploadPhase === "error") {
		return {
			...base,
			state: "failed",
			...(retainedVideoId ? { videoId: retainedVideoId } : {}),
			error: operation.uploadError ?? "The Cap import failed.",
		};
	}
	if (operation.state === "queued" && parentState === "failed") {
		return {
			...base,
			state: "uncertain",
			...(retainedVideoId ? { videoId: retainedVideoId } : {}),
			error: "Batch stopped before dispatch was confirmed.",
		};
	}
	return {
		...base,
		state: operation.state === "running" ? "processing" : "queued",
		...(retainedVideoId ? { videoId: retainedVideoId } : {}),
	};
};

export async function getLoomBatchStatus({
	operationId,
	organizationId,
	currentUserId,
	includeAllRows = false,
}: {
	operationId: string;
	organizationId: Organisation.OrganisationId;
	currentUserId: User.UserId;
	includeAllRows?: boolean;
}): Promise<LoomBatchStatus> {
	await authorizeExtensionLoomImport({ userId: currentUserId, organizationId });
	const [operation] = await db()
		.select()
		.from(Db.agentApiOperations)
		.where(
			and(
				eq(Db.agentApiOperations.id, operationId),
				eq(Db.agentApiOperations.kind, LOOM_BATCH_OPERATION_KIND),
				eq(Db.agentApiOperations.resourceId, organizationId),
				eq(Db.agentApiOperations.userId, currentUserId),
			),
		)
		.limit(1);
	if (!operation || !isLoomBatchPayload(operation.payload)) {
		throw new LoomBatchNotFoundError("Loom batch operation was not found.");
	}
	const payload = operation.payload;
	const childIds = payload.rows.map((row) =>
		getLoomBatchChildOperationId(operationId, row.loomVideoId),
	);
	const counts = {
		total: payload.rows.length,
		queued: 0,
		processing: 0,
		ready: 0,
		failed: 0,
		uncertain: 0,
	};
	let recordedRows = 0;
	for (let index = 0; index < childIds.length; index += 1_000) {
		const chunk = childIds.slice(index, index + 1_000);
		const [aggregate] = await db()
			.select({
				recorded: sql<number>`COUNT(*)`,
				queued: sql<number>`COALESCE(SUM(CASE WHEN ${Db.agentApiOperations.state} = 'queued' AND (${Db.videoUploads.phase} IS NULL OR ${Db.videoUploads.phase} <> 'error') THEN 1 ELSE 0 END), 0)`,
				processing: sql<number>`COALESCE(SUM(CASE WHEN ${Db.agentApiOperations.state} = 'running' AND (${Db.videoUploads.phase} IS NULL OR ${Db.videoUploads.phase} <> 'error') THEN 1 ELSE 0 END), 0)`,
				ready: sql<number>`COALESCE(SUM(CASE WHEN ${Db.agentApiOperations.state} = 'succeeded' AND (${Db.videoUploads.phase} IS NULL OR ${Db.videoUploads.phase} = 'complete') AND ${Db.videos.id} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
				failed: sql<number>`COALESCE(SUM(CASE WHEN (${Db.agentApiOperations.state} = 'failed' AND (${Db.agentApiOperations.errorCode} IS NULL OR ${Db.agentApiOperations.errorCode} <> 'LOOM_IMPORT_UNCERTAIN')) OR (${Db.agentApiOperations.state} IN ('queued', 'running') AND ${Db.videoUploads.phase} = 'error') THEN 1 ELSE 0 END), 0)`,
				uncertain: sql<number>`COALESCE(SUM(CASE WHEN (${Db.agentApiOperations.state} = 'failed' AND ${Db.agentApiOperations.errorCode} = 'LOOM_IMPORT_UNCERTAIN') OR (${Db.agentApiOperations.state} = 'succeeded' AND (${Db.videos.id} IS NULL OR (${Db.videoUploads.phase} IS NOT NULL AND ${Db.videoUploads.phase} <> 'complete'))) THEN 1 ELSE 0 END), 0)`,
			})
			.from(Db.agentApiOperations)
			.leftJoin(
				Db.videos,
				eq(Db.videos.id, Db.agentApiOperations.resultResourceId),
			)
			.leftJoin(Db.videoUploads, eq(Db.videoUploads.videoId, Db.videos.id))
			.where(
				and(
					inArray(Db.agentApiOperations.id, chunk),
					eq(Db.agentApiOperations.kind, LOOM_BATCH_OPERATION_KIND),
					eq(Db.agentApiOperations.resourceId, organizationId),
					eq(Db.agentApiOperations.userId, currentUserId),
					sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiOperations.payload}, '$.type')) = 'loom_child'`,
					sql`JSON_EXTRACT(${Db.agentApiOperations.payload}, '$.version') = 1`,
					sql`JSON_UNQUOTE(JSON_EXTRACT(${Db.agentApiOperations.payload}, '$.parentId')) = ${operationId}`,
				),
			);
		recordedRows += Number(aggregate?.recorded ?? 0);
		counts.queued += Number(aggregate?.queued ?? 0);
		counts.processing += Number(aggregate?.processing ?? 0);
		counts.ready += Number(aggregate?.ready ?? 0);
		counts.failed += Number(aggregate?.failed ?? 0);
		counts.uncertain += Number(aggregate?.uncertain ?? 0);
	}
	const unpreparedRows = Math.max(0, payload.rows.length - recordedRows);
	if (operation.state === "failed" || operation.state === "succeeded") {
		counts.uncertain += unpreparedRows;
	} else {
		counts.queued += unpreparedRows;
	}
	if (operation.state === "failed") {
		counts.uncertain += counts.queued;
		counts.queued = 0;
	}

	const detailRows = includeAllRows ? payload.rows : payload.rows.slice(0, 100);
	const detailIds = detailRows.map((row) =>
		getLoomBatchChildOperationId(operationId, row.loomVideoId),
	);
	const childRows: ChildStatusRecord[] = [];
	for (let index = 0; index < detailIds.length; index += 1_000) {
		const chunk = detailIds.slice(index, index + 1_000);
		childRows.push(
			...(await db()
				.select({
					id: Db.agentApiOperations.id,
					userId: Db.agentApiOperations.userId,
					resourceId: Db.agentApiOperations.resourceId,
					state: Db.agentApiOperations.state,
					payload: Db.agentApiOperations.payload,
					result: Db.agentApiOperations.result,
					resultResourceId: Db.agentApiOperations.resultResourceId,
					errorCode: Db.agentApiOperations.errorCode,
					errorMessage: Db.agentApiOperations.errorMessage,
					videoId: Db.videos.id,
					uploadPhase: Db.videoUploads.phase,
					uploadError: Db.videoUploads.processingError,
				})
				.from(Db.agentApiOperations)
				.leftJoin(
					Db.videos,
					eq(Db.videos.id, Db.agentApiOperations.resultResourceId),
				)
				.leftJoin(Db.videoUploads, eq(Db.videoUploads.videoId, Db.videos.id))
				.where(
					and(
						inArray(Db.agentApiOperations.id, chunk),
						eq(Db.agentApiOperations.kind, LOOM_BATCH_OPERATION_KIND),
						eq(Db.agentApiOperations.resourceId, organizationId),
						eq(Db.agentApiOperations.userId, currentUserId),
					),
				)),
		);
	}
	const childById = new Map(childRows.map((row) => [row.id, row]));
	const rows = detailRows.map((row) =>
		statusRowFromChild(
			payload,
			row,
			childById.get(getLoomBatchChildOperationId(operationId, row.loomVideoId)),
			operation.state,
		),
	);
	const progress = isLoomBatchProgress(operation.result)
		? operation.result
		: initialLoomBatchProgress(payload);
	const hasPendingRows = counts.queued + counts.processing > 0;
	const state =
		operation.state === "failed"
			? "failed"
			: operation.state === "queued"
				? "queued"
				: operation.state === "running"
					? "running"
					: hasPendingRows
						? "dispatched"
						: "complete";
	const phase =
		state === "failed"
			? "failed"
			: state === "queued"
				? "queued"
				: state === "dispatched"
					? "monitoring"
					: state === "complete"
						? "complete"
						: progress.phase === "dispatching"
							? "dispatching"
							: "preparing";

	return {
		operationId,
		organizationId,
		state,
		phase,
		source: payload.source,
		counts,
		currentRowNumber: progress.currentRowNumber,
		rows,
		rowsTruncated: !includeAllRows && payload.rows.length > detailRows.length,
		...(operation.errorMessage ? { error: operation.errorMessage } : {}),
		createdAt: operation.createdAt.toISOString(),
		updatedAt: operation.updatedAt.toISOString(),
		completedAt: operation.completedAt?.toISOString() ?? null,
	};
}
