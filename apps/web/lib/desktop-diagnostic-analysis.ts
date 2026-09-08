import { z } from "zod";

const MAX_SCAN_CHARACTERS = 4 * 1024 * 1024;
const MAX_OPERATIONS = 4096;
const label = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
const counter = z.number().int().nonnegative().safe();
const identity = z.object({
	session: counter,
	process: counter,
	sequence: counter,
});
const recordSchema = z.object({
	schemaVersion: z.literal(2),
	operationId: identity,
	parentOperationId: identity.nullish(),
	revision: counter,
	app: z
		.object({
			flavor: label,
			version: z.string().max(128),
			sourceRevision: z.string().max(64).nullish(),
			sourceDirty: z.boolean().nullish(),
			debugBuild: z.boolean(),
		})
		.nullish(),
	os: label,
	binaryArchitecture: label,
	operation: label,
	startedAtUnixMs: counter,
	elapsedMs: counter,
	stage: label,
	outcome: z.enum([
		"in_progress",
		"returned_ok",
		"returned_error",
		"incomplete",
		"observed",
	]),
	fields: z
		.array(
			z
				.object({
					name: label,
					value: z.union([counter, z.boolean(), z.string().max(128)]),
				})
				.nullable(),
		)
		.max(16),
	omittedFields: counter,
});
type Record = z.infer<typeof recordSchema>;
type Stage = Pick<Record, "revision" | "stage" | "elapsedMs" | "outcome">;

function operationKey(id: z.infer<typeof identity>) {
	return `${id.session}:${id.process}:${id.sequence}`;
}

function isObject(value: unknown): value is { [key: string]: unknown } {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function analyzeDesktopDiagnostics(log: string, context: unknown) {
	const operations = new Map<
		string,
		{ latest: Record; stages: Map<number, Stage>; updatesObserved: number }
	>();
	let invalidRecords = 0;
	let unsupportedRecords = 0;
	let recordsOmittedForOperationLimit = 0;
	let omittedStages = 0;
	const accept = (value: unknown) => {
		if (isObject(value) && value.schemaVersion !== 2) {
			unsupportedRecords++;
			return;
		}
		const parsed = recordSchema.safeParse(value);
		if (!parsed.success) {
			invalidRecords++;
			return;
		}
		const record = parsed.data;
		const key = operationKey(record.operationId);
		let operation = operations.get(key);
		if (!operation) {
			if (operations.size >= MAX_OPERATIONS) {
				recordsOmittedForOperationLimit++;
				return;
			}
			operation = { latest: record, stages: new Map(), updatesObserved: 0 };
			operations.set(key, operation);
		}
		operation.updatesObserved++;
		if (
			record.revision > operation.latest.revision ||
			(record.revision === operation.latest.revision &&
				record.elapsedMs > operation.latest.elapsedMs)
		) {
			operation.latest = record;
		}
		if (!operation.stages.has(record.revision)) {
			if (operation.stages.size >= 32) {
				omittedStages++;
			} else {
				operation.stages.set(record.revision, {
					revision: record.revision,
					stage: record.stage,
					elapsedMs: record.elapsedMs,
					outcome: record.outcome,
				});
			}
		}
	};
	const snapshot =
		isObject(context) && isObject(context.operations)
			? context.operations
			: undefined;
	if (Array.isArray(snapshot?.records)) {
		for (const record of snapshot.records.slice(-64)) accept(record);
	}
	const scanned = log.slice(-MAX_SCAN_CHARACTERS);
	for (const line of scanned.split("\n").reverse()) {
		if (!line.startsWith("CAP_DIAGNOSTIC ")) continue;
		if (line.length > 4096) {
			invalidRecords++;
			continue;
		}
		try {
			accept(JSON.parse(line.slice("CAP_DIAGNOSTIC ".length)));
		} catch {
			invalidRecords++;
		}
	}
	const reconstructed = [...operations.entries()]
		.map(([id, { latest, stages, updatesObserved }]) => ({
			id,
			parentId: latest.parentOperationId
				? operationKey(latest.parentOperationId)
				: null,
			...latest,
			fields: Object.fromEntries(
				latest.fields
					.filter((field) => field !== null)
					.map((field) => [field.name, field.value]),
			),
			stages: [...stages.values()].sort((a, b) => a.revision - b.revision),
			updatesObserved,
		}))
		.sort(
			(a, b) =>
				a.startedAtUnixMs - b.startedAtUnixMs ||
				a.operationId.session - b.operationId.session ||
				a.operationId.process - b.operationId.process ||
				a.operationId.sequence - b.operationId.sequence,
		);
	const counts = {
		observedOperations: reconstructed.length,
		returnedOk: 0,
		returnedError: 0,
		incomplete: 0,
		noTerminalRecord: 0,
		healthObservations: 0,
	};
	for (const record of reconstructed) {
		switch (record.outcome) {
			case "returned_ok":
				counts.returnedOk++;
				break;
			case "returned_error":
				counts.returnedError++;
				break;
			case "incomplete":
				counts.incomplete++;
				break;
			case "in_progress":
				counts.noTerminalRecord++;
				break;
			case "observed":
				counts.healthObservations++;
				break;
		}
	}
	return {
		schemaVersion: 1,
		scope: "uploaded_sample_only",
		outcomeSemantics: "return_value_only_not_media_validation",
		missingTerminalSemantics: "may_be_active_interrupted_or_missing_data",
		healthEventScope: "process_only_not_proof_of_operation_causation",
		counts,
		coverage: {
			invalidRecords,
			unsupportedRecords,
			recordsOmittedForOperationLimit,
			omittedStages,
			logCharactersOmittedFromAnalysis: log.length - scanned.length,
			journalWriteFailures: snapshot?.journalWriteFailures ?? null,
			loggerDroppedMessages: snapshot?.loggerDroppedMessages ?? null,
			omittedRecords: snapshot?.omittedRecords ?? null,
			historyDroppedUpdates: snapshot?.droppedUpdates ?? null,
		},
		operations: reconstructed,
	};
}
