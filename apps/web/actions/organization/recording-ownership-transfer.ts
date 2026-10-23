"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { agentApiOperations } from "@cap/database/schema";
import { and, eq, inArray, ne } from "drizzle-orm";
import { start } from "workflow/api";
import { z } from "zod";
import { CONTENT_TRANSFER_KIND } from "@/lib/content-transfer";
import {
	ownershipPreflightSecret,
	prepareOwnershipPreflight,
} from "@/lib/recording-ownership-preflight";
import {
	loadOwnershipSnapshot,
	type OwnershipTransaction,
	type OwnershipTransferPayload,
	ownershipStore,
	readOwnershipOperation,
	requireOriginalOwnershipDestination,
	requireOwnershipAccess,
	requireOwnershipDestination,
	writeOwnershipFields,
} from "@/lib/recording-ownership-repository";
import {
	OWNERSHIP_TRANSFER_MODE,
	OwnershipTransferError,
	ownershipFields,
	ownershipHash,
	planOwnershipTransfer,
	requireOwnershipPlanReady,
	requireTransferQuiescent,
	verifyTransferMedia,
} from "@/lib/recording-ownership-transfer";
import { transferRecordingOwnershipWorkflow } from "@/workflows/transfer-recording-ownership";

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,15}$/);
const requestSchema = z
	.object({
		videoId: id,
		targetUserId: id,
		destinationFolderId: id.nullable(),
		preflightReceipt: z
			.string()
			.max(8 * 1024 ** 2)
			.optional(),
	})
	.strict();
type Request = z.infer<typeof requestSchema>;

async function manager(targetUserId?: string) {
	const user = await getCurrentUser();
	if (!user?.activeOrganizationId) throw new Error("Unauthorized");
	await requireOwnershipAccess(
		db(),
		user.activeOrganizationId,
		user.id,
		targetUserId ?? user.id,
	);
	return user;
}

async function preview(
	input: Request,
	user: Awaited<ReturnType<typeof manager>>,
) {
	const snapshot = await loadOwnershipSnapshot(db(), input.videoId);
	if (snapshot.video.orgId !== user.activeOrganizationId)
		throw new Error("Forbidden");
	requireTransferQuiescent(snapshot);
	await requireOwnershipDestination(
		db(),
		snapshot,
		input.targetUserId,
		input.destinationFolderId,
	);
	return planOwnershipTransfer(
		snapshot,
		input.targetUserId,
		input.destinationFolderId,
		await ownershipStore({
			videoId: snapshot.video.id,
			organizationId: snapshot.video.orgId,
			bucketId: snapshot.video.bucket,
			before: ownershipFields(snapshot),
		}),
		input.preflightReceipt
			? { token: input.preflightReceipt, secret: ownershipPreflightSecret() }
			: undefined,
	);
}

async function noOtherTransfer(
	tx: OwnershipTransaction,
	organizationId: string,
	operationId: string,
) {
	const [active] = await tx
		.select({ id: agentApiOperations.id })
		.from(agentApiOperations)
		.where(
			and(
				eq(agentApiOperations.kind, CONTENT_TRANSFER_KIND),
				eq(agentApiOperations.resourceId, organizationId),
				inArray(agentApiOperations.state, ["queued", "running"]),
				ne(agentApiOperations.id, operationId),
			),
		);
	if (active) throw new Error("Another content transfer is already running");
}

export async function prepareRecordingOwnershipPreflight(
	input: Omit<Request, "preflightReceipt">,
) {
	const request = requestSchema.omit({ preflightReceipt: true }).parse(input);
	const user = await manager(request.targetUserId);
	try {
		const snapshot = await loadOwnershipSnapshot(db(), request.videoId);
		if (snapshot.video.orgId !== user.activeOrganizationId)
			throw new Error("Forbidden");
		requireTransferQuiescent(snapshot);
		await requireOwnershipDestination(
			db(),
			snapshot,
			request.targetUserId,
			request.destinationFolderId,
		);
		const challenge = await prepareOwnershipPreflight(
			snapshot,
			request.targetUserId,
			request.destinationFolderId,
			await ownershipStore({
				videoId: snapshot.video.id,
				organizationId: snapshot.video.orgId,
				bucketId: snapshot.video.bucket,
				before: ownershipFields(snapshot),
			}),
		);
		await requireOwnershipAccess(
			db(),
			snapshot.video.orgId,
			user.id,
			request.targetUserId,
		);
		if (
			ownershipHash(await loadOwnershipSnapshot(db(), request.videoId)) !==
			ownershipHash(snapshot)
		)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		return challenge;
	} catch {
		throw new OwnershipTransferError("NOT_READY");
	}
}

export async function previewRecordingOwnershipTransfer(input: Request) {
	const request = requestSchema.parse(input);
	const user = await manager(request.targetUserId);
	try {
		const plan = await preview(request, user);
		return {
			ready: true as const,
			previewToken: ownershipHash(plan),
			objectCount: plan.objects.length,
		};
	} catch (error) {
		return {
			ready: false as const,
			reason:
				error instanceof OwnershipTransferError ? error.code : "STORAGE_FAILED",
		};
	}
}

export async function startRecordingOwnershipTransfer(
	input: Request & { requestId: string; previewToken: string },
) {
	const { requestId, previewToken, ...request } = requestSchema
		.extend({ requestId: id, previewToken: z.string().regex(/^[a-f0-9]{64}$/) })
		.parse(input);
	const user = await manager(request.targetUserId);
	const requestHash = ownershipHash({
		...request,
		previewToken,
		actorId: user.id,
		organizationId: user.activeOrganizationId,
	});
	const [existing] = await db()
		.select()
		.from(agentApiOperations)
		.where(eq(agentApiOperations.id, requestId));
	if (existing) {
		const { payload } = readOwnershipOperation(existing);
		if (
			existing.userId !== user.id ||
			existing.resourceId !== user.activeOrganizationId ||
			payload.requestHash !== requestHash
		)
			throw new Error("Request conflicts with an existing operation");
		return { operationId: existing.id };
	}
	let plan: Awaited<ReturnType<typeof preview>>;
	try {
		plan = await preview(request, user);
	} catch (error) {
		throw new OwnershipTransferError(
			error instanceof OwnershipTransferError ? error.code : "STORAGE_FAILED",
		);
	}
	if (ownershipHash(plan) !== previewToken)
		throw new OwnershipTransferError("SNAPSHOT_CHANGED");
	const payload: OwnershipTransferPayload = {
		version: 2,
		mode: OWNERSHIP_TRANSFER_MODE,
		requestedByUserId: user.id,
		requestHash,
		plan,
	};
	await db().transaction(async (tx) => {
		await requireOwnershipAccess(
			tx,
			plan.organizationId,
			user.id,
			plan.targetUserId,
			true,
		);
		const [duplicate] = await tx
			.select()
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, requestId))
			.for("update");
		if (duplicate) {
			const existingPayload = readOwnershipOperation(duplicate).payload;
			if (existingPayload.requestHash !== requestHash)
				throw new Error("Request conflicts with an existing operation");
			return;
		}
		await noOtherTransfer(tx, plan.organizationId, requestId);
		const snapshot = await loadOwnershipSnapshot(tx, plan.videoId, true);
		if (ownershipHash(snapshot) !== plan.snapshotHash)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		requireOwnershipPlanReady(
			snapshot,
			plan,
			plan.preflight ? ownershipPreflightSecret() : undefined,
		);
		await tx.insert(agentApiOperations).values({
			id: requestId,
			userId: user.id,
			kind: CONTENT_TRANSFER_KIND,
			resourceId: user.activeOrganizationId,
			state: "running",
			payload,
			result: { phase: "copying" },
		});
	});
	try {
		await start(transferRecordingOwnershipWorkflow, [
			{ operationId: requestId },
		]);
	} catch {
		// Start may have succeeded before its response was lost. The journal
		// remains resumable, and all repeated copy/publication attempts are fenced.
		return { operationId: requestId };
	}
	return { operationId: requestId };
}

async function authorizedOperation(operationId: string) {
	id.parse(operationId);
	const user = await manager();
	const [operation] = await db()
		.select()
		.from(agentApiOperations)
		.where(
			and(
				eq(agentApiOperations.id, operationId),
				eq(agentApiOperations.resourceId, user.activeOrganizationId),
			),
		);
	if (!operation) throw new Error("Operation not found");
	return { user, operation, ...readOwnershipOperation(operation) };
}

export async function getRecordingOwnershipTransfer(operationId: string) {
	const { operation, result } = await authorizedOperation(operationId);
	return {
		state: operation.state,
		phase: result.phase,
		errorCode: operation.errorCode,
	};
}

export async function retryRecordingOwnershipTransfer(operationId: string) {
	const { user, payload, result } = await authorizedOperation(operationId);
	if (result.phase !== "copying") return { operationId };
	await db().transaction(async (tx) => {
		await requireOwnershipAccess(
			tx,
			payload.plan.organizationId,
			user.id,
			payload.plan.targetUserId,
			true,
		);
		await noOtherTransfer(tx, payload.plan.organizationId, operationId);
		const [operation] = await tx
			.select()
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, operationId))
			.for("update");
		if (
			!operation ||
			readOwnershipOperation(operation).result.phase !== "copying"
		)
			return;
		await tx
			.update(agentApiOperations)
			.set({
				state: "running",
				errorCode: null,
				errorMessage: null,
				completedAt: null,
			})
			.where(eq(agentApiOperations.id, operationId));
	});
	try {
		await start(transferRecordingOwnershipWorkflow, [{ operationId }]);
	} catch {
		return { operationId };
	}
	return { operationId };
}

export async function rollbackRecordingOwnershipTransfer(input: {
	operationId: string;
	dryRun: boolean;
}) {
	const { operationId, dryRun } = z
		.object({ operationId: id, dryRun: z.boolean() })
		.strict()
		.parse(input);
	const { user, payload, result } = await authorizedOperation(operationId);
	const { plan } = payload;
	if (result.phase === "rolled_back" || result.phase === "cancelled")
		return { phase: result.phase };
	if (result.phase === "applied") {
		await requireOwnershipAccess(
			db(),
			plan.organizationId,
			user.id,
			plan.before.ownerId,
		);
		if (!result.afterHash || !result.destinations)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		const snapshot = await loadOwnershipSnapshot(db(), plan.videoId);
		if (ownershipHash(snapshot) !== result.afterHash)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		await requireOriginalOwnershipDestination(db(), snapshot, plan);
		try {
			await verifyTransferMedia(
				plan,
				await ownershipStore(plan),
				result.destinations,
			);
		} catch {
			throw new OwnershipTransferError("MEDIA_CHANGED");
		}
	}
	if (dryRun) return { phase: "ready" as const };
	return db().transaction(async (tx) => {
		await requireOwnershipAccess(
			tx,
			plan.organizationId,
			user.id,
			result.phase === "applied" ? plan.before.ownerId : user.id,
			true,
		);
		if (result.phase === "applied")
			await noOtherTransfer(tx, plan.organizationId, operationId);
		const [locked] = await tx
			.select()
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, operationId))
			.for("update");
		if (!locked) throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		const currentResult = readOwnershipOperation(locked).result;
		if (
			currentResult.phase === "rolled_back" ||
			currentResult.phase === "cancelled"
		)
			return { phase: currentResult.phase };
		if (ownershipHash(currentResult) !== ownershipHash(result))
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		if (result.phase === "applied") {
			const snapshot = await loadOwnershipSnapshot(tx, plan.videoId, true);
			requireTransferQuiescent(snapshot);
			if (ownershipHash(snapshot) !== result.afterHash)
				throw new OwnershipTransferError("SNAPSHOT_CHANGED");
			await requireOriginalOwnershipDestination(tx, snapshot, plan, true);
			await writeOwnershipFields(tx, snapshot, plan.before);
		}
		const phase =
			result.phase === "applied"
				? ("rolled_back" as const)
				: ("cancelled" as const);
		await tx
			.update(agentApiOperations)
			.set({
				state: "succeeded",
				result: { ...currentResult, phase },
				errorCode: null,
				errorMessage: null,
				completedAt: new Date(),
			})
			.where(eq(agentApiOperations.id, operationId));
		return { phase };
	});
}
