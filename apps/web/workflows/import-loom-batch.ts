import { sleep } from "workflow";
import type {
	LoomBatchParentContext,
	LoomBatchPayloadRow,
	LoomBatchProgress,
} from "@/lib/loom-batch";
import {
	claimLoomBatchOperation,
	completeLoomBatchOperation,
	dispatchLoomBatchChild,
	failLoomBatchOperation,
	type LoomBatchPreparation,
	prepareLoomBatchRow,
	setLoomBatchProgress,
} from "@/lib/loom-batch-import";

const advancePreparation = (
	progress: LoomBatchProgress,
	row: LoomBatchPayloadRow,
	preparation: LoomBatchPreparation,
): LoomBatchProgress => ({
	...progress,
	phase:
		preparation.state === "dispatch" || preparation.state === "processing"
			? "dispatching"
			: "preparing",
	preparedRows:
		progress.preparedRows +
		(preparation.state === "dispatch" || preparation.state === "processing"
			? 0
			: 1),
	readyRows: progress.readyRows + (preparation.state === "ready" ? 1 : 0),
	failedRows: progress.failedRows + (preparation.state === "failed" ? 1 : 0),
	uncertainRows:
		progress.uncertainRows + (preparation.state === "uncertain" ? 1 : 0),
	currentRowNumber: row.rowNumber,
});

async function claimOperation(operationId: string) {
	"use step";

	return claimLoomBatchOperation(operationId);
}

async function prepareRow(
	operationId: string,
	parent: LoomBatchParentContext,
	row: LoomBatchPayloadRow,
	progress: LoomBatchProgress,
) {
	"use step";

	const preparation = await prepareLoomBatchRow(operationId, parent, row);
	const nextProgress = advancePreparation(progress, row, preparation);
	await setLoomBatchProgress(operationId, nextProgress);
	return { preparation, progress: nextProgress };
}

async function dispatchRow(
	operationId: string,
	preparation: LoomBatchPreparation,
	progress: LoomBatchProgress,
) {
	"use step";

	if (preparation.state === "dispatch") {
		await dispatchLoomBatchChild(preparation.childOperationId);
	}
	if (preparation.state !== "dispatch" && preparation.state !== "processing") {
		return progress;
	}
	const nextProgress: LoomBatchProgress = {
		...progress,
		phase: "dispatching",
		preparedRows: progress.preparedRows + 1,
		dispatchedRows: progress.dispatchedRows + 1,
	};
	await setLoomBatchProgress(operationId, nextProgress);
	return nextProgress;
}

async function completeOperation(
	operationId: string,
	progress: LoomBatchProgress,
) {
	"use step";

	await completeLoomBatchOperation(operationId, progress);
}

async function failOperation(operationId: string, error: unknown) {
	"use step";

	await failLoomBatchOperation(operationId, error);
}

export async function importLoomBatchWorkflow(input: { operationId: string }) {
	"use workflow";

	try {
		const claimed = await claimOperation(input.operationId);
		if (!claimed) return;
		let progress = claimed.progress;
		const parent = {
			requestId: claimed.payload.requestId,
			organizationId: claimed.payload.organizationId,
			requestedByUserId: claimed.payload.requestedByUserId,
			defaultPublic: claimed.payload.defaultPublic,
		};
		for (
			let index = claimed.progress.preparedRows;
			index < claimed.payload.rows.length;
			index++
		) {
			const row = claimed.payload.rows[index];
			if (!row) continue;
			const prepared = await prepareRow(
				input.operationId,
				parent,
				row,
				progress,
			);
			progress = await dispatchRow(
				input.operationId,
				prepared.preparation,
				prepared.progress,
			);
			if (index < claimed.payload.rows.length - 1) await sleep("1500ms");
		}
		await completeOperation(input.operationId, progress);
	} catch (error) {
		await failOperation(input.operationId, error);
		throw error;
	}
}
