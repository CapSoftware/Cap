export const LOOM_MIGRATION_STATUSES = [
	"pending",
	"in_progress",
	"needs_information",
	"completed",
] as const;

export type LoomMigrationStatus = (typeof LOOM_MIGRATION_STATUSES)[number];

export class LoomMigrationError extends Error {
	override name = "LoomMigrationError";
}

export type LoomMigrationResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string };

export function unwrapLoomMigrationResult<T>(result: LoomMigrationResult<T>) {
	if (!result.ok) throw new Error(result.error);
	return result.value;
}

export const LOOM_MIGRATION_STATUS_LABELS: Record<LoomMigrationStatus, string> =
	{
		pending: "Pending",
		in_progress: "In progress",
		needs_information: "Information needed",
		completed: "Migration complete",
	};

export function normalizeMigrationText(
	value: string,
	label: string,
	maxLength: number,
) {
	if (typeof value !== "string")
		throw new LoomMigrationError(`${label} is invalid.`);
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length > maxLength) {
		throw new LoomMigrationError(
			`${label} must be ${maxLength} characters or fewer.`,
		);
	}
	return normalized;
}

export function validateLoomMigrationInventory({
	organizationId,
	imports,
}: {
	organizationId: string;
	imports: ReadonlyArray<{
		videoId: string | null;
		videoOrganizationId: string | null;
		mappingId: string | null;
		mappingOrganizationId: string | null;
		source: string | null;
		phase: string | null;
	}>;
}) {
	if (
		imports.some(
			(row) =>
				!row.videoId ||
				row.videoOrganizationId !== organizationId ||
				row.mappingId !== row.videoId ||
				row.mappingOrganizationId !== organizationId ||
				row.source !== "loom",
		)
	) {
		throw new LoomMigrationError(
			"Loom import recordings or source mappings are missing or changed. Re-import missing sources, then use Reconcile deleted recordings for deleted inventory entries. Restore changed mappings before completion.",
		);
	}
	if (imports.some((row) => row.phase !== null && row.phase !== "complete")) {
		throw new LoomMigrationError(
			"Loom imports are still processing or have errors. Resolve them before completion.",
		);
	}
}

export function validateOperatorMigrationUpdate({
	currentStatus,
	nextStatus,
	message,
	verified,
	expectedVideoCount,
	importedVideoCount,
}: {
	currentStatus: LoomMigrationStatus;
	nextStatus: LoomMigrationStatus;
	message: string;
	verified: boolean;
	expectedVideoCount: number | null;
	importedVideoCount: number;
}) {
	if (currentStatus === "completed") {
		throw new LoomMigrationError("A completed migration cannot be changed.");
	}
	if (!LOOM_MIGRATION_STATUSES.includes(nextStatus)) {
		throw new LoomMigrationError("Invalid migration status.");
	}
	const normalizedMessage = normalizeMigrationText(message, "Message", 2000);
	if (nextStatus === "needs_information" && !normalizedMessage) {
		throw new LoomMigrationError(
			"Tell the customer what information you need.",
		);
	}
	if (nextStatus === "completed" && !verified) {
		throw new LoomMigrationError(
			"Verify the migrated library before marking it complete.",
		);
	}
	if (nextStatus === "completed" && expectedVideoCount === null) {
		throw new LoomMigrationError(
			"Enter the agreed source video count before completion.",
		);
	}
	if (
		!Number.isInteger(importedVideoCount) ||
		importedVideoCount < 0 ||
		(expectedVideoCount !== null &&
			(!Number.isInteger(expectedVideoCount) ||
				expectedVideoCount < 0 ||
				importedVideoCount > expectedVideoCount))
	) {
		throw new LoomMigrationError("Enter valid video counts.");
	}
	if (
		nextStatus === "completed" &&
		expectedVideoCount !== null &&
		importedVideoCount !== expectedVideoCount
	) {
		throw new LoomMigrationError(
			"Reconcile the expected video count before completion.",
		);
	}
	return normalizedMessage;
}
