import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	operator: vi.fn(),
	transaction: vi.fn(),
	rows: [] as unknown[][],
	select: vi.fn(),
	delete: vi.fn(),
	deleteWhere: vi.fn(),
	update: vi.fn(),
	set: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({ transaction: mocks.transaction }),
}));
vi.mock("@cap/database/schema", () => ({
	loomMigrationRequests: { id: "request.id" },
	loomMigrationImports: {
		requestId: "inventory.requestId",
		videoId: "inventory.videoId",
	},
	videos: { id: "video.id" },
}));
vi.mock("drizzle-orm", () => ({
	and: (...conditions: unknown[]) => ({ and: conditions }),
	eq: (left: unknown, right: unknown) => ({ eq: [left, right] }),
	inArray: (column: unknown, values: unknown[]) => ({
		inArray: [column, values],
	}),
	isNull: (column: unknown) => ({ isNull: column }),
	notExists: (query: unknown) => ({ notExists: query }),
}));
vi.mock("@/lib/loom-concierge", () => ({
	requireMigrationOperator: mocks.operator,
}));

import { reconcileMissingLoomMigrationImports } from "@/lib/loom-migration-inventory";

const input = { requestId: "request12345678", verified: true };
const request = {
	status: "in_progress",
	organizationId: "destination",
	activeOrganizationId: "destination",
	activeImportCount: 0,
};

describe("operator migration inventory reconciliation", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.rows = [[request], []];
		mocks.operator.mockResolvedValue({ id: "operator" });
		mocks.select.mockImplementation(() => {
			const builder = {
				from: vi.fn().mockReturnThis(),
				leftJoin: vi.fn().mockReturnThis(),
				where: vi.fn().mockReturnThis(),
				limit: vi.fn().mockReturnThis(),
				for: vi.fn(async () => mocks.rows.shift() ?? []),
			};
			return builder;
		});
		mocks.delete.mockReturnValue({ where: mocks.deleteWhere });
		mocks.deleteWhere.mockResolvedValue([{ affectedRows: 1 }]);
		mocks.set.mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
		mocks.update.mockReturnValue({ set: mocks.set });
		mocks.transaction.mockImplementation(async (fn: (tx: unknown) => unknown) =>
			fn({ select: mocks.select, delete: mocks.delete, update: mocks.update }),
		);
	});

	it("requires operator access before reading migration state", async () => {
		mocks.operator.mockRejectedValue(new Error("Forbidden"));
		await expect(reconcileMissingLoomMigrationImports(input)).rejects.toThrow(
			"Forbidden",
		);
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it("requires an explicit source-list reconciliation confirmation", async () => {
		await expect(
			reconcileMissingLoomMigrationImports({ ...input, verified: false }),
		).rejects.toThrow("source list first");
		expect(mocks.transaction).not.toHaveBeenCalled();
	});

	it.each([
		undefined,
		{ ...request, status: "completed" },
		{ ...request, activeOrganizationId: null },
		{ ...request, activeOrganizationId: "other" },
		{ ...request, activeImportCount: 1 },
		{
			...request,
			activeImportCount: 1,
			activeImportLeaseUntil: new Date(Date.now() + 60_000),
		},
	])("holds inactive requests and concurrent imports: %j", async (row) => {
		mocks.rows = [row ? [row] : []];
		await expect(reconcileMissingLoomMigrationImports(input)).rejects.toThrow(
			"inactive or imports",
		);
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("does not mutate requests without missing recordings", async () => {
		await expect(reconcileMissingLoomMigrationImports(input)).resolves.toEqual({
			removedCount: 0,
			hasMore: false,
		});
		expect(mocks.delete).not.toHaveBeenCalled();
		expect(mocks.update).not.toHaveBeenCalled();
	});

	it("permits inventory-only reconciliation after an import reservation expires", async () => {
		mocks.rows = [
			[
				{
					...request,
					activeImportCount: 1,
					activeImportLeaseUntil: new Date(0),
				},
			],
			[],
		];
		await expect(reconcileMissingLoomMigrationImports(input)).resolves.toEqual({
			removedCount: 0,
			hasMore: false,
		});
		expect(mocks.delete).not.toHaveBeenCalled();
	});

	it("bounds cleanup, rechecks absent videos and never changes completion or counts", async () => {
		mocks.rows = [
			[request],
			Array.from({ length: 101 }, (_, i) => ({ videoId: `deleted-${i}` })),
		];
		mocks.deleteWhere.mockResolvedValue([{ affectedRows: 100 }]);
		await expect(reconcileMissingLoomMigrationImports(input)).resolves.toEqual({
			removedCount: 100,
			hasMore: true,
		});
		expect(mocks.delete).toHaveBeenCalledWith({
			requestId: "inventory.requestId",
			videoId: "inventory.videoId",
		});
		const conditions = mocks.deleteWhere.mock.calls[0]?.[0].and;
		expect(conditions[0]).toEqual({
			eq: ["inventory.requestId", input.requestId],
		});
		expect(conditions[1].inArray[1]).toHaveLength(100);
		expect(conditions[2].notExists.where).toHaveBeenCalledWith({
			eq: ["video.id", "inventory.videoId"],
		});
		expect(mocks.set).toHaveBeenCalledWith({
			lastOperatorUserId: "operator",
			lastOperatorAt: expect.any(Date),
			updatedAt: expect.any(Date),
		});
	});
});
