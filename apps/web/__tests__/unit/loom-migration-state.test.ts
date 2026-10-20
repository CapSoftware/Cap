import { describe, expect, it } from "vitest";
import { validateOperatorMigrationUpdate } from "@/lib/loom-migration-state";

const base = {
	currentStatus: "in_progress" as const,
	nextStatus: "completed" as const,
	message: "Migration finished",
	verified: true,
	expectedVideoCount: 12,
	importedVideoCount: 12,
};

describe("Loom migration completion", () => {
	it("requires a verified library and reconciled counts", () => {
		expect(() =>
			validateOperatorMigrationUpdate({ ...base, verified: false }),
		).toThrow("Verify the migrated library");
		expect(() =>
			validateOperatorMigrationUpdate({ ...base, importedVideoCount: 11 }),
		).toThrow("Reconcile the expected video count");
		expect(() =>
			validateOperatorMigrationUpdate({ ...base, expectedVideoCount: null }),
		).toThrow("Enter the agreed source video count");
	});

	it("requires a useful message when Cap asks for information", () => {
		expect(() =>
			validateOperatorMigrationUpdate({
				...base,
				nextStatus: "needs_information",
				message: "  ",
			}),
		).toThrow("Tell the customer");
	});

	it("accepts completion after verification", () => {
		expect(validateOperatorMigrationUpdate(base)).toBe("Migration finished");
	});
});
