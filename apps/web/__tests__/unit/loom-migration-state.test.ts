import { describe, expect, it } from "vitest";
import {
	validateLoomMigrationInventory,
	validateOperatorMigrationUpdate,
} from "@/lib/loom-migration-state";

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

describe("Loom migration destination inventory", () => {
	const imported = {
		videoId: "video",
		videoOrganizationId: "destination",
		mappingId: "video",
		mappingOrganizationId: "destination",
		source: "loom",
		phase: null,
	};

	it("accepts completed recordings with and without retained upload rows", () => {
		expect(() =>
			validateLoomMigrationInventory({
				organizationId: "destination",
				imports: [imported, { ...imported, phase: "complete" }],
			}),
		).not.toThrow();
	});

	it.each([
		{ videoId: null, videoOrganizationId: null },
		{ videoOrganizationId: "another-organization" },
		{ mappingId: null, mappingOrganizationId: null, source: null },
		{ mappingId: "another-recording" },
		{ mappingOrganizationId: "another-organization" },
		{ source: "another-source" },
	])("blocks a missing or changed destination: %j", (changes) => {
		expect(() =>
			validateLoomMigrationInventory({
				organizationId: "destination",
				imports: [imported, { ...imported, ...changes }],
			}),
		).toThrow("missing or changed");
	});

	it.each(["uploading", "processing", "generating_thumbnail", "error"])(
		"blocks an import that is %s",
		(phase) => {
			expect(() =>
				validateLoomMigrationInventory({
					organizationId: "destination",
					imports: [imported, { ...imported, phase }],
				}),
			).toThrow("still processing");
		},
	);
});
