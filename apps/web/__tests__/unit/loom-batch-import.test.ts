import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const databaseMocks = vi.hoisted(() => {
	const selectResults: unknown[] = [];
	const databaseTarget = {
		select: vi.fn(),
		insert: vi.fn(),
		update: vi.fn(),
		from: vi.fn(),
		leftJoin: vi.fn(),
		where: vi.fn(),
		limit: vi.fn(),
		for: vi.fn(),
		values: vi.fn(),
		set: vi.fn(),
		transaction: vi.fn(),
	};
	const then = vi.fn();
	const database = new Proxy(databaseTarget, {
		get(target, property, receiver) {
			if (property === "then") return then;
			return Reflect.get(target, property, receiver);
		},
	});
	database.select.mockImplementation(() => database);
	database.insert.mockImplementation(() => database);
	database.update.mockImplementation(() => database);
	database.from.mockImplementation(() => database);
	database.leftJoin.mockImplementation(() => database);
	database.where.mockImplementation(() => database);
	database.limit.mockImplementation(() => database);
	database.values.mockResolvedValue(undefined);
	database.set.mockImplementation(() => database);
	database.for.mockImplementation(() => Promise.resolve(selectResults.shift()));
	database.transaction.mockImplementation(
		(callback: (transaction: typeof database) => unknown) => callback(database),
	);
	then.mockImplementation(
		(
			resolve: (value: unknown) => unknown,
			reject: (reason: unknown) => unknown,
		) => Promise.resolve(selectResults.shift()).then(resolve, reject),
	);
	return { database, selectResults, then };
});

const extensionMocks = vi.hoisted(() => ({
	authorize: vi.fn(),
}));

const loomImportMocks = vi.hoisted(() => ({
	download: vi.fn(),
}));

const provisioningMocks = vi.hoisted(() => ({
	provision: vi.fn(),
}));

const workflowApiMocks = vi.hoisted(() => ({
	start: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(() => databaseMocks.database),
}));

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({ CAP_VIDEOS_DEFAULT_PUBLIC: false })),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {},
}));

vi.mock("server-only", () => ({}));

vi.mock("@/lib/extension-loom-import", () => ({
	authorizeExtensionLoomImport: extensionMocks.authorize,
	canonicalizeExtensionLoomUrl: (value: string) => {
		const match = value
			.trim()
			.match(
				/^https:\/\/(?:www\.)?loom\.com\/(?:share|embed)\/([0-9a-f]{32})\/?$/i,
			);
		return match?.[1]
			? `https://www.loom.com/share/${match[1].toLowerCase()}`
			: undefined;
	},
	ExtensionLoomAuthorizationError: class extends Error {},
	validateExtensionLoomRow: () => undefined,
}));

vi.mock("@/lib/loom-import", () => ({
	downloadLoomVideo: loomImportMocks.download,
}));

vi.mock("@/lib/organization-provisioning", () => ({
	provisionOrganizationInvitee: provisioningMocks.provision,
}));

vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise: vi.fn(),
}));

vi.mock("workflow/api", () => ({
	start: workflowApiMocks.start,
}));

vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

const firstLoomId = "0123456789abcdef0123456789abcdef";
const secondLoomId = "fedcba9876543210fedcba9876543210";
const thirdLoomId = "11111111111111111111111111111111";
const fourthLoomId = "22222222222222222222222222222222";
const fifthLoomId = "33333333333333333333333333333333";

const request = {
	requestId: "019e312d-21ae-7a6f-8c4f-b24a34b0c54d",
	expectedUserId: "user-1",
	expectedDefaultPublic: false,
	organizationId: "organization-1",
	rows: [
		{
			rowNumber: 2,
			loomUrl: `https://loom.com/share/${firstLoomId}`,
			userEmail: " Owner@Example.com ",
			spaceName: " Product   demos ",
		},
		{
			rowNumber: 3,
			loomUrl: `https://www.loom.com/embed/${firstLoomId.toUpperCase()}`,
			userEmail: "duplicate@example.com",
		},
		{
			rowNumber: 4,
			loomUrl: `https://www.loom.com/share/${secondLoomId}`,
			userEmail: "second@example.com",
			spaceName: "   ",
		},
	],
	source: {
		workspace: " Example workspace ",
		from: "2026-01-01",
		to: "2026-09-02",
		totalRows: 4,
		omittedRows: 1,
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	databaseMocks.selectResults.length = 0;
	databaseMocks.database.select.mockImplementation(
		() => databaseMocks.database,
	);
	databaseMocks.database.insert.mockImplementation(
		() => databaseMocks.database,
	);
	databaseMocks.database.update.mockImplementation(
		() => databaseMocks.database,
	);
	databaseMocks.database.from.mockImplementation(() => databaseMocks.database);
	databaseMocks.database.leftJoin.mockImplementation(
		() => databaseMocks.database,
	);
	databaseMocks.database.where.mockImplementation(() => databaseMocks.database);
	databaseMocks.database.limit.mockImplementation(() => databaseMocks.database);
	databaseMocks.database.values.mockResolvedValue(undefined);
	databaseMocks.database.set.mockImplementation(() => databaseMocks.database);
	databaseMocks.database.for.mockImplementation(() =>
		Promise.resolve(databaseMocks.selectResults.shift()),
	);
	databaseMocks.database.transaction.mockImplementation(
		(callback: (transaction: typeof databaseMocks.database) => unknown) =>
			callback(databaseMocks.database),
	);
	databaseMocks.then.mockImplementation(
		(
			resolve: (value: unknown) => unknown,
			reject: (reason: unknown) => unknown,
		) =>
			Promise.resolve(databaseMocks.selectResults.shift()).then(
				resolve,
				reject,
			),
	);
});

describe("Loom batch request normalization", () => {
	it("canonicalizes and deduplicates Loom IDs while preserving source totals", async () => {
		const { normalizeLoomBatchRequest } = await import(
			"@/lib/loom-batch-import"
		);
		const payload = normalizeLoomBatchRequest(request, "user-1");

		expect(payload.rows).toEqual([
			{
				rowNumber: 2,
				loomUrl: `https://www.loom.com/share/${firstLoomId}`,
				loomVideoId: firstLoomId,
				userEmail: "owner@example.com",
				spaceName: "Product demos",
			},
			{
				rowNumber: 4,
				loomUrl: `https://www.loom.com/share/${secondLoomId}`,
				loomVideoId: secondLoomId,
				userEmail: "second@example.com",
				spaceName: undefined,
			},
		]);
		expect(payload.source).toEqual({
			workspace: "Example workspace",
			from: "2026-01-01",
			to: "2026-09-02",
			totalRows: 4,
			omittedRows: 2,
		});
		expect(payload.defaultPublic).toBe(false);
	});

	it("derives stable IDs and request hashes from the complete normalized request", async () => {
		const { getLoomBatchOperationId, normalizeLoomBatchRequest } = await import(
			"@/lib/loom-batch-import"
		);
		const first = normalizeLoomBatchRequest(request, "user-1");
		const second = normalizeLoomBatchRequest(request, "user-1");

		expect(first.requestHash).toHaveLength(64);
		expect(second.requestHash).toBe(first.requestHash);
		expect(
			getLoomBatchOperationId("user-1", "organization-1", request.requestId),
		).toHaveLength(15);
	});

	it("rejects identity and source metadata drift before enqueue", async () => {
		const { normalizeLoomBatchRequest } = await import(
			"@/lib/loom-batch-import"
		);

		expect(() => normalizeLoomBatchRequest(request, "user-2")).toThrow();
		expect(() =>
			normalizeLoomBatchRequest(
				{
					...request,
					source: { ...request.source, totalRows: 5 },
				},
				"user-1",
			),
		).toThrow("Loom source metadata is invalid.");
	});

	it("rejects null nested payloads and preserves monotonic progress", async () => {
		const {
			initialLoomBatchProgress,
			isLoomBatchChildPayload,
			isLoomBatchPayload,
			mergeLoomBatchProgress,
		} = await import("@/lib/loom-batch");
		const { normalizeLoomBatchRequest } = await import(
			"@/lib/loom-batch-import"
		);
		const payload = normalizeLoomBatchRequest(request, "user-1");
		const current = {
			...initialLoomBatchProgress(payload),
			phase: "dispatching" as const,
			preparedRows: 2,
			dispatchedRows: 2,
		};
		const stale = {
			...current,
			preparedRows: 1,
			dispatchedRows: 1,
		};

		expect(isLoomBatchPayload({ ...payload, source: null })).toBe(false);
		expect(
			isLoomBatchChildPayload({
				type: "loom_child",
				version: 1,
				parentId: "parent",
				organizationId: "organization-1",
				requestedByUserId: "user-1",
				row: null,
			}),
		).toBe(false);
		expect(
			isLoomBatchChildPayload({
				type: "loom_child",
				version: 1,
				parentId: "parent",
				organizationId: "organization-1",
				requestedByUserId: "user-1",
				row: {
					rowNumber: 2,
					loomVideoId: firstLoomId,
					userEmail: "owner@example.com",
				},
				dispatch: null,
			}),
		).toBe(false);
		expect(mergeLoomBatchProgress(current, stale)).toBe(current);
	});
});

describe("Loom batch durable operation behavior", () => {
	it("restarts a persisted queued parent after an ambiguous initial start", async () => {
		const { normalizeLoomBatchRequest, startLoomBatchImport } = await import(
			"@/lib/loom-batch-import"
		);
		const payload = normalizeLoomBatchRequest(request, "user-1");
		const startBatchWorkflow = vi
			.fn()
			.mockRejectedValueOnce(new Error("ambiguous submit"))
			.mockResolvedValueOnce(undefined);
		databaseMocks.selectResults.push([{ id: "organization-1" }], [], []);

		await expect(
			startLoomBatchImport({
				request,
				currentUserId: "user-1" as never,
				startBatchWorkflow,
			}),
		).rejects.toThrow("ambiguous submit");
		databaseMocks.selectResults.push(
			[{ id: "organization-1" }],
			[
				{
					userId: "user-1",
					resourceId: "organization-1",
					payload,
					state: "queued",
				},
			],
		);

		const receipt = await startLoomBatchImport({
			request,
			currentUserId: "user-1" as never,
			startBatchWorkflow,
		});

		expect(startBatchWorkflow).toHaveBeenCalledTimes(2);
		expect(startBatchWorkflow).toHaveBeenLastCalledWith(receipt.operationId);
		expect(databaseMocks.database.insert).toHaveBeenCalledTimes(1);
		expect(databaseMocks.database.update).not.toHaveBeenCalled();
	});

	it("rejects reuse of the same request ID with a different payload", async () => {
		const {
			getLoomBatchOperationId,
			normalizeLoomBatchRequest,
			startLoomBatchImport,
		} = await import("@/lib/loom-batch-import");
		const payload = normalizeLoomBatchRequest(request, "user-1");
		const conflictingPayload = {
			...payload,
			requestHash: "f".repeat(64),
		};
		databaseMocks.selectResults.push(
			[{ id: "organization-1" }],
			[
				{
					userId: "user-1",
					resourceId: "organization-1",
					payload: conflictingPayload,
					state: "queued",
				},
			],
		);
		const startBatchWorkflow = vi.fn();

		await expect(
			startLoomBatchImport({
				request,
				currentUserId: "user-1" as never,
				startBatchWorkflow,
			}),
		).rejects.toThrow(
			"Request ID was already used for a different Loom batch.",
		);
		expect(startBatchWorkflow).not.toHaveBeenCalled();
		expect(databaseMocks.database.insert).not.toHaveBeenCalled();
		expect(
			getLoomBatchOperationId("user-1", "organization-1", request.requestId),
		).toHaveLength(15);
	});

	it("replays a saved child without repeating preparation side effects", async () => {
		const {
			dispatchLoomBatchChild,
			getLoomBatchChildOperationId,
			getLoomBatchOperationId,
			normalizeLoomBatchRequest,
			prepareLoomBatchRow,
		} = await import("@/lib/loom-batch-import");
		const payload = normalizeLoomBatchRequest(request, "user-1");
		const row = payload.rows[0];
		expect(row).toBeDefined();
		if (!row) return;
		const parentId = getLoomBatchOperationId(
			"user-1",
			"organization-1",
			request.requestId,
		);
		const childOperationId = getLoomBatchChildOperationId(
			parentId,
			row.loomVideoId,
		);
		const childOperation = {
			id: childOperationId,
			userId: "user-1",
			resourceId: "organization-1",
			state: "queued",
			payload: {
				type: "loom_child",
				version: 1,
				parentId,
				organizationId: "organization-1",
				requestedByUserId: "user-1",
				row: {
					rowNumber: row.rowNumber,
					loomVideoId: row.loomVideoId,
					userEmail: row.userEmail,
					spaceName: row.spaceName,
				},
				dispatch: {
					videoId: "video-1",
					ownerId: "owner-1",
					rawFileKey: "owner-1/video-1/raw-upload.mp4",
					bucketId: null,
					loomVideoId: row.loomVideoId,
				},
			},
			result: null,
			resultResourceId: "video-1",
			errorCode: null,
			errorMessage: null,
		};
		databaseMocks.selectResults.push([childOperation]);

		await expect(prepareLoomBatchRow(parentId, payload, row)).resolves.toEqual({
			childOperationId,
			state: "dispatch",
		});
		databaseMocks.selectResults.push([childOperation]);
		await expect(dispatchLoomBatchChild(childOperationId)).resolves.toBe(true);

		expect(workflowApiMocks.start).toHaveBeenCalledWith(expect.any(Function), [
			expect.objectContaining({
				agentOperationId: childOperationId,
				videoId: "video-1",
			}),
		]);
		expect(loomImportMocks.download).not.toHaveBeenCalled();
		expect(provisioningMocks.provision).not.toHaveBeenCalled();
		expect(databaseMocks.database.transaction).not.toHaveBeenCalled();
		expect(databaseMocks.database.insert).not.toHaveBeenCalled();
	});

	it("continues a running parent from its durable progress", async () => {
		const { claimLoomBatchOperation, normalizeLoomBatchRequest } = await import(
			"@/lib/loom-batch-import"
		);
		const payload = normalizeLoomBatchRequest(request, "user-1");
		const progress = {
			phase: "dispatching",
			totalRows: 2,
			preparedRows: 1,
			dispatchedRows: 1,
			readyRows: 0,
			failedRows: 0,
			uncertainRows: 0,
			currentRowNumber: 2,
		};
		const operation = {
			id: "parent-operation",
			userId: "user-1",
			resourceId: "organization-1",
			kind: "import_loom",
			state: "running",
			payload,
			result: progress,
		};
		databaseMocks.selectResults.push([operation], [operation]);

		await expect(claimLoomBatchOperation("parent-operation")).resolves.toEqual({
			payload,
			progress,
		});
		expect(databaseMocks.database.update).not.toHaveBeenCalled();
		expect(extensionMocks.authorize).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "organization-1",
		});
	});

	it("combines durable child states with unprepared rows in status counts", async () => {
		const {
			getLoomBatchChildOperationId,
			getLoomBatchOperationId,
			getLoomBatchStatus,
			normalizeLoomBatchRequest,
		} = await import("@/lib/loom-batch-import");
		const statusRequest = {
			...request,
			rows: [
				{
					rowNumber: 2,
					loomUrl: `https://loom.com/share/${firstLoomId}`,
					userEmail: "owner@example.com",
					spaceName: "Product demos",
				},
				{
					rowNumber: 3,
					loomUrl: `https://loom.com/share/${secondLoomId}`,
					userEmail: "second@example.com",
				},
				{
					rowNumber: 4,
					loomUrl: `https://loom.com/share/${thirdLoomId}`,
					userEmail: "third@example.com",
				},
				{
					rowNumber: 5,
					loomUrl: `https://loom.com/share/${fourthLoomId}`,
					userEmail: "fourth@example.com",
				},
				{
					rowNumber: 6,
					loomUrl: `https://loom.com/share/${fifthLoomId}`,
					userEmail: "fifth@example.com",
				},
			],
			source: { ...request.source, totalRows: 5, omittedRows: 0 },
		};
		const payload = normalizeLoomBatchRequest(statusRequest, "user-1");
		const operationId = getLoomBatchOperationId(
			"user-1",
			"organization-1",
			request.requestId,
		);
		const childPayload = (index: number) => {
			const row = payload.rows[index];
			expect(row).toBeDefined();
			if (!row) throw new Error("Missing fixture row.");
			return {
				type: "loom_child",
				version: 1,
				parentId: operationId,
				organizationId: "organization-1",
				requestedByUserId: "user-1",
				row: {
					rowNumber: row.rowNumber,
					loomVideoId: row.loomVideoId,
					userEmail: row.userEmail,
					spaceName: row.spaceName,
				},
			};
		};
		const childRecord = (
			index: number,
			state: "queued" | "running" | "succeeded" | "failed",
			overrides: Record<string, unknown> = {},
		) => {
			const row = payload.rows[index];
			if (!row) throw new Error("Missing fixture row.");
			return {
				id: getLoomBatchChildOperationId(operationId, row.loomVideoId),
				userId: "user-1",
				resourceId: "organization-1",
				state,
				payload: childPayload(index),
				result: null,
				resultResourceId: null,
				errorCode: null,
				errorMessage: null,
				videoId: null,
				uploadPhase: null,
				uploadError: null,
				...overrides,
			};
		};
		const now = new Date("2026-09-02T12:00:00.000Z");
		databaseMocks.selectResults.push(
			[
				{
					id: operationId,
					userId: "user-1",
					kind: "import_loom",
					resourceId: "organization-1",
					state: "running",
					payload,
					result: {
						phase: "dispatching",
						totalRows: 5,
						preparedRows: 4,
						dispatchedRows: 2,
						readyRows: 1,
						failedRows: 0,
						uncertainRows: 1,
						currentRowNumber: 5,
					},
					errorMessage: null,
					createdAt: now,
					updatedAt: now,
					completedAt: null,
				},
			],
			[
				{
					recorded: 4,
					queued: 1,
					processing: 1,
					ready: 1,
					failed: 0,
					uncertain: 1,
				},
			],
			[
				childRecord(0, "queued"),
				childRecord(1, "running"),
				childRecord(2, "succeeded", {
					result: { videoId: "video-ready", existing: true },
					resultResourceId: "video-ready",
					videoId: "video-ready",
				}),
				childRecord(3, "succeeded", {
					result: { videoId: "deleted-video" },
					resultResourceId: "deleted-video",
				}),
			],
		);

		const status = await getLoomBatchStatus({
			operationId,
			organizationId: "organization-1" as never,
			currentUserId: "user-1" as never,
		});

		expect(status.counts).toEqual({
			total: 5,
			queued: 2,
			processing: 1,
			ready: 1,
			failed: 0,
			uncertain: 1,
		});
		expect(status.rows.map((row) => row.state)).toEqual([
			"queued",
			"processing",
			"ready",
			"uncertain",
			"queued",
		]);
		expect(status.state).toBe("running");
		expect(status.phase).toBe("dispatching");
		expect(status.rows[3]).toEqual(
			expect.objectContaining({
				state: "uncertain",
				videoId: "deleted-video",
			}),
		);
	});
});

describe("Loom batch durability contract", () => {
	it("prepares each row before dispatch and spaces starts by 1.5 seconds", () => {
		const source = readFileSync(
			join(process.cwd(), "workflows/import-loom-batch.ts"),
			"utf8",
		);
		const workflow = source.slice(
			source.indexOf("export async function importLoomBatchWorkflow"),
		);

		expect(workflow.indexOf("prepareRow(")).toBeLessThan(
			workflow.indexOf("dispatchRow("),
		);
		expect(workflow).toContain('sleep("1500ms")');
		expect(workflow).toContain("let index = claimed.progress.preparedRows;");
	});

	it("creates video, upload, source mapping, and child operation in one transaction", () => {
		const source = readFileSync(
			join(process.cwd(), "lib/loom-batch-import.ts"),
			"utf8",
		);
		const preparation = source.slice(
			source.indexOf("export async function prepareLoomBatchRow"),
			source.indexOf("export async function claimLoomBatchOperation"),
		);

		expect(preparation).toContain(
			"return await db().transaction(async (tx) =>",
		);
		expect(preparation).toContain("tx.insert(Db.videos)");
		expect(preparation).toContain("tx.insert(Db.videoUploads)");
		expect(preparation).toContain("tx.insert(Db.importedVideos)");
		expect(preparation).toContain("tx.insert(Db.agentApiOperations)");
		expect(source).toContain('if (locked.state === "running")');
		expect(source).toContain(
			"serverEnv().CAP_VIDEOS_DEFAULT_PUBLIC !== payload.defaultPublic",
		);
	});

	it("keeps routine status rows bounded and exposes explicit full reports", () => {
		const route = readFileSync(
			join(process.cwd(), "app/api/extension/import-loom/batch/route.ts"),
			"utf8",
		);
		const backend = readFileSync(
			join(process.cwd(), "lib/loom-batch-import.ts"),
			"utf8",
		);

		expect(route).toContain('report: Schema.optional(Schema.Literal("1"))');
		expect(backend).toContain("payload.rows.slice(0, 100)");
		expect(backend).toContain("rowsTruncated:");
	});
});
