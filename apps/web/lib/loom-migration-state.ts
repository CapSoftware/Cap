export const LOOM_MIGRATION_STATUSES = [
	"pending",
	"in_progress",
	"needs_information",
	"completed",
] as const;

export type LoomMigrationStatus = (typeof LOOM_MIGRATION_STATUSES)[number];

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
	if (typeof value !== "string") throw new Error(`${label} is invalid.`);
	const normalized = value.trim().replace(/\s+/g, " ");
	if (normalized.length > maxLength) {
		throw new Error(`${label} must be ${maxLength} characters or fewer.`);
	}
	return normalized;
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
		throw new Error("A completed migration cannot be changed.");
	}
	if (!LOOM_MIGRATION_STATUSES.includes(nextStatus)) {
		throw new Error("Invalid migration status.");
	}
	const normalizedMessage = normalizeMigrationText(message, "Message", 2000);
	if (nextStatus === "needs_information" && !normalizedMessage) {
		throw new Error("Tell the customer what information you need.");
	}
	if (nextStatus === "completed" && !verified) {
		throw new Error("Verify the migrated library before marking it complete.");
	}
	if (nextStatus === "completed" && expectedVideoCount === null) {
		throw new Error("Enter the agreed source video count before completion.");
	}
	if (
		!Number.isInteger(importedVideoCount) ||
		importedVideoCount < 0 ||
		(expectedVideoCount !== null &&
			(!Number.isInteger(expectedVideoCount) ||
				expectedVideoCount < 0 ||
				importedVideoCount > expectedVideoCount))
	) {
		throw new Error("Enter valid video counts.");
	}
	if (
		nextStatus === "completed" &&
		expectedVideoCount !== null &&
		importedVideoCount !== expectedVideoCount
	) {
		throw new Error("Reconcile the expected video count before completion.");
	}
	return normalizedMessage;
}
