import { db } from "@cap/database";
import { agentApiOperations } from "@cap/database/schema";
import { and, eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { ownershipPreflightSecret } from "@/lib/recording-ownership-preflight";
import {
	loadOwnershipSnapshot,
	ownershipStore,
	readOwnershipOperation,
	requireOwnershipAccess,
	requireOwnershipDestination,
	writeOwnershipFields,
} from "@/lib/recording-ownership-repository";
import {
	copyOwnershipMedia,
	OwnershipTransferError,
	ownershipHash,
	requireOwnershipPlanReady,
	transferredOwnershipFields,
} from "@/lib/recording-ownership-transfer";

export async function executeOwnershipTransfer(operationId: string) {
	"use step";

	try {
		const [operation] = await db()
			.select()
			.from(agentApiOperations)
			.where(eq(agentApiOperations.id, operationId));
		if (!operation) throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		const { payload, result } = readOwnershipOperation(operation);
		if (result.phase !== "copying" || operation.state !== "running") return;
		const { plan } = payload;
		await requireOwnershipAccess(
			db(),
			plan.organizationId,
			payload.requestedByUserId,
			plan.targetUserId,
		);
		const snapshot = await loadOwnershipSnapshot(db(), plan.videoId);
		if (
			requireOwnershipPlanReady(
				snapshot,
				plan,
				plan.preflight ? ownershipPreflightSecret() : undefined,
			) !== plan.completion ||
			ownershipHash(snapshot) !== plan.snapshotHash
		)
			throw new OwnershipTransferError("SNAPSHOT_CHANGED");
		await requireOwnershipDestination(
			db(),
			snapshot,
			plan.targetUserId,
			plan.destinationFolderId,
		);
		const destinations = await copyOwnershipMedia(
			plan,
			await ownershipStore(plan),
		);
		await db().transaction(async (tx) => {
			await requireOwnershipAccess(
				tx,
				plan.organizationId,
				payload.requestedByUserId,
				plan.targetUserId,
				true,
			);
			const [locked] = await tx
				.select()
				.from(agentApiOperations)
				.where(eq(agentApiOperations.id, operationId))
				.for("update");
			if (!locked) throw new OwnershipTransferError("SNAPSHOT_CHANGED");
			const currentOperation = readOwnershipOperation(locked);
			if (
				currentOperation.result.phase !== "copying" ||
				locked.state !== "running"
			)
				return;
			const current = await loadOwnershipSnapshot(tx, plan.videoId, true);
			if (
				requireOwnershipPlanReady(
					current,
					plan,
					plan.preflight ? ownershipPreflightSecret() : undefined,
				) !== plan.completion ||
				ownershipHash(current) !== plan.snapshotHash
			)
				throw new OwnershipTransferError("SNAPSHOT_CHANGED");
			await requireOwnershipDestination(
				tx,
				current,
				plan.targetUserId,
				plan.destinationFolderId,
				true,
			);
			await writeOwnershipFields(
				tx,
				current,
				transferredOwnershipFields(plan, destinations),
			);
			const after = await loadOwnershipSnapshot(tx, plan.videoId);
			await tx
				.update(agentApiOperations)
				.set({
					state: "succeeded",
					result: {
						phase: "applied",
						afterHash: ownershipHash(after),
						destinations,
					},
					completedAt: new Date(),
					errorCode: null,
					errorMessage: null,
				})
				.where(eq(agentApiOperations.id, operationId));
		});
	} catch (error) {
		const code =
			error instanceof OwnershipTransferError ? error.code : "STORAGE_FAILED";
		await db()
			.update(agentApiOperations)
			.set({
				state: "failed",
				errorCode: code,
				errorMessage:
					"Recording ownership transfer held; no original media was removed",
				completedAt: new Date(),
			})
			.where(
				and(
					eq(agentApiOperations.id, operationId),
					eq(agentApiOperations.state, "running"),
				),
			);
		throw new FatalError(`Recording ownership transfer held: ${code}`);
	}
}

export async function transferRecordingOwnershipWorkflow(input: {
	operationId: string;
}) {
	"use workflow";
	await executeOwnershipTransfer(input.operationId);
}
