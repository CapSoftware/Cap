import { describe, expect, it } from "vitest";
import { detectColumns, parseInventory } from "./inventory";
import {
	type ImportDraft,
	type ImportRun,
	restoreImportInventory,
} from "./persistence";

const table = parseInventory(
	"Video Link,Creator\nhttps://www.loom.com/share/0123456789abcdef0123456789abcdef,alex@example.test",
	"inventory.csv",
);
const draft: ImportDraft = {
	id: "fixture-inventory",
	fileName: "inventory.csv",
	table,
	mapping: detectColumns(table.headers),
	options: {
		ownerMode: "column",
		ownerEmail: "",
		spaceMode: "none",
		spaceName: "",
	},
	selected: [1],
	organizationId: "fixture-organization",
};
const run: ImportRun = {
	draftId: draft.id,
	apiBaseUrl: "https://cap.example.test",
	userId: "fixture-user",
	organizationId: draft.organizationId,
	outcomes: { 1: { sourceRecord: 1, state: "sending" } },
};

describe("saved importer recovery", () => {
	it("opens an empty store and restores a review without a run", () => {
		expect(restoreImportInventory(undefined, undefined)).toEqual({
			draft: null,
			run: null,
		});
		expect(restoreImportInventory(draft, null)).toEqual({ draft, run: null });
	});

	it("turns an interrupted request into uncertainty without changing the saved input", () => {
		const restored = restoreImportInventory(draft, run);
		expect(restored.run?.outcomes[1]).toMatchObject({
			sourceRecord: 1,
			state: "uncertain",
			message: expect.stringContaining("Check your dashboard"),
		});
		expect(restored.draft?.selected).toEqual([1]);
		expect(run.outcomes[1].state).toBe("sending");
	});

	it.each(["started", "existing", "failed", "uncertain"] as const)(
		"preserves the %s outcome and its account binding",
		(state) => {
			const saved = {
				...run,
				outcomes: {
					1: { sourceRecord: 1, state, videoId: "fixture-video" },
				},
			};
			expect(restoreImportInventory(draft, saved).run).toEqual(saved);
		},
	);

	it.each([
		{ ...draft, table: { ...table, records: [[42]] } },
		{ ...draft, mapping: { ...draft.mapping, owner: 20 } },
		{ ...draft, mapping: { ...draft.mapping, owner: 0.5 } },
		{ ...draft, options: { ...draft.options, ownerMode: "unknown" } },
		{ ...draft, selected: [2] },
		{ ...draft, selected: [1, 1] },
		{ ...draft, table: { ...table, headers: ["Creator", "creator"] } },
	])(
		"rejects malformed saved reviews instead of guessing mappings",
		(saved) => {
			expect(() => restoreImportInventory(saved, null)).toThrow(
				/cannot be read safely/,
			);
		},
	);

	it.each([
		{ ...run, draftId: "another-inventory" },
		{ ...run, apiBaseUrl: "javascript:alert(1)" },
		{ ...run, apiBaseUrl: "https://user:password@cap.example.test" },
		{ ...run, outcomes: null },
		{ ...run, outcomes: { 1: { sourceRecord: 2, state: "started" } } },
		{ ...run, outcomes: { 1: { sourceRecord: 1, state: "unknown" } } },
		{ ...run, outcomes: { 1: { sourceRecord: 1, state: "started" } } },
		{ ...run, outcomes: { 1: { sourceRecord: 1, state: "existing" } } },
	])("rejects unreadable progress rather than clearing the run", (saved) => {
		expect(() => restoreImportInventory(draft, saved)).toThrow(
			/Check your Cap dashboard/,
		);
	});

	it("does not discard progress when its inventory is missing", () => {
		expect(() => restoreImportInventory(null, run)).toThrow(
			/cannot be read safely/,
		);
	});
});
