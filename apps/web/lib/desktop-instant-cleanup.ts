const CLEANUP_REASONS = new Set([
	"start-failed",
	"start-cancelled",
	"interrupted",
]);

const START_FAILURE_CAUSES = new Set([
	"permission",
	"microphone",
	"camera",
	"capture",
	"storage",
	"account",
	"network",
	"other",
]);

export type InstantCleanupReport = {
	reason: string;
	cause: string | null;
	app: "gpui" | "desktop";
};

export function readInstantCleanupReport(
	reason: string | undefined,
	cause: string | undefined,
	isGpui: boolean,
): InstantCleanupReport | null {
	if (!reason || !CLEANUP_REASONS.has(reason)) return null;
	return {
		reason,
		cause: cause && START_FAILURE_CAUSES.has(cause) ? cause : null,
		app: isGpui ? "gpui" : "desktop",
	};
}
