import {
	openPreflight,
	preflightHash,
	preflightRequestHash,
	preflightRequestSchema,
	sealPreflight,
} from "@cap/utils/recording-ownership-preflight";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnershipMediaStore } from "@/lib/recording-ownership-transfer";
import {
	legacyOwnershipFixture,
	mediaFixture,
	ownershipFixture,
	sourcePrefix,
	targetPrefix,
} from "../helpers/ownership-transfer";

type Row = Record<string, unknown>;
type Column = { field: string };
type Table = { tableName: string };
type Predicate = (row: Row) => boolean;

const state = vi.hoisted(() => ({
	rows: {} as Record<string, Row[]>,
	writes: [] as string[],
	media: undefined as OwnershipMediaStore | undefined,
	user: { id: "test-admin", activeOrganizationId: "test-org" } as {
		id: string;
		activeOrganizationId: string;
	} | null,
	start: vi.fn(),
	beforeTransaction: undefined as (() => void) | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
	redirect: (path: string) => {
		throw new Error(`Redirect: ${path}`);
	},
}));
vi.mock(
	"@/app/(org)/dashboard/settings/organization/content/recording-ownership/RecordingOwnership",
	() => ({ RecordingOwnership: () => null }),
);
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_WEBHOOK_SECRET:
			"synthetic-preflight-authentication-fixture-only",
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => state.user,
}));
vi.mock("workflow/api", () => ({ start: state.start }));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("@cap/web-backend/src/Storage/index", async () => {
	const { Effect } = await import("effect");
	return { Storage: { getAccessForVideo: () => Effect.succeed([{}]) } };
});
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/recording-ownership-storage", () => ({
	makeOwnershipMediaStore: () => state.media,
}));
vi.mock("drizzle-orm", () => ({
	eq:
		(column: Column, value: unknown): Predicate =>
		(row) =>
			row[column.field] === value,
	ne:
		(column: Column, value: unknown): Predicate =>
		(row) =>
			row[column.field] !== value,
	isNull:
		(column: Column): Predicate =>
		(row) =>
			row[column.field] == null,
	inArray:
		(column: Column, values: unknown[]): Predicate =>
		(row) =>
			values.includes(row[column.field]),
	and:
		(...conditions: Predicate[]): Predicate =>
		(row) =>
			conditions.every((condition) => condition(row)),
}));
vi.mock("@cap/database/schema", () =>
	Object.fromEntries(
		[
			"videos",
			"comments",
			"videoUploads",
			"videoEdits",
			"videoProcessingJobs",
			"agentApiOperations",
			"organizations",
			"organizationMembers",
			"folders",
			"spaces",
			"s3Buckets",
		].map((name) => [
			name,
			new Proxy(
				{ tableName: name },
				{
					get: (target, property) =>
						property === "tableName" ? target.tableName : { field: property },
				},
			),
		]),
	),
);
vi.mock("@cap/database", () => {
	let tail = Promise.resolve();
	const client = {
		select: (fields?: Record<string, Column>) => ({
			from: (table: Table) => ({
				where: (predicate: Predicate) => {
					const selected = () =>
						structuredClone(
							(state.rows[table.tableName] ?? [])
								.filter(predicate)
								.map((row) =>
									fields
										? Object.fromEntries(
												Object.entries(fields).map(([key, column]) => [
													key,
													row[column.field],
												]),
											)
										: row,
								),
						);
					return Object.assign(Promise.resolve(selected()), {
						for: async () => selected(),
					});
				},
			}),
		}),
		update: (table: Table) => ({
			set: (changes: Row) => ({
				where: async (predicate: Predicate) => {
					for (const row of state.rows[table.tableName] ?? []) {
						if (!predicate(row)) continue;
						Object.assign(row, structuredClone(changes));
						state.writes.push(table.tableName);
					}
				},
			}),
		}),
		insert: (table: Table) => ({
			values: async (row: Row) => {
				const rows = state.rows[table.tableName] ?? [];
				rows.push(structuredClone(row));
				state.rows[table.tableName] = rows;
				state.writes.push(table.tableName);
			},
		}),
	};
	return {
		db: () => ({
			...client,
			transaction: <T>(run: (tx: typeof client) => Promise<T>) => {
				const job = tail.then(async () => {
					state.beforeTransaction?.();
					const before = structuredClone(state.rows);
					try {
						return await run(client);
					} catch (error) {
						state.rows = before;
						throw error;
					}
				});
				tail = job.then(
					() => {},
					() => {},
				);
				return job;
			},
		}),
	};
});

import {
	getRecordingOwnershipTransfer,
	prepareRecordingOwnershipPreflight,
	previewRecordingOwnershipTransfer,
	retryRecordingOwnershipTransfer,
	rollbackRecordingOwnershipTransfer,
	startRecordingOwnershipTransfer,
} from "@/actions/organization/recording-ownership-transfer";
import RecordingOwnershipPage from "@/app/(org)/dashboard/settings/organization/content/recording-ownership/page";
import { executeOwnershipTransfer } from "@/workflows/transfer-recording-ownership";

const request = {
	videoId: "test-video",
	targetUserId: "test-target",
	destinationFolderId: null,
};
let media: ReturnType<typeof mediaFixture>;

function row(table: string) {
	const found = state.rows[table]?.[0];
	if (!found) throw new Error("Missing synthetic row");
	return found;
}

beforeEach(() => {
	const fixture = ownershipFixture();
	media = mediaFixture();
	state.media = media.store;
	state.user = { id: "test-admin", activeOrganizationId: "test-org" };
	state.beforeTransaction = undefined;
	state.start.mockResolvedValue({});
	state.writes = [];
	state.rows = {
		videos: [
			{
				...fixture.video,
				public: false,
				password: "synthetic-password-hash",
				settings: { disableComments: false },
			},
			{ ...structuredClone(fixture.video), id: "test-sibling" },
		],
		videoUploads: [fixture.upload as Row],
		videoEdits: [fixture.edit as Row],
		comments: fixture.comments.map((comment) => ({
			...comment,
			videoId: fixture.video.id,
			authorId: "test-author",
			content: "Synthetic comment",
		})),
		videoProcessingJobs: [fixture.processing as Row],
		organizations: [
			{ id: "test-org", ownerId: "test-admin", tombstoneAt: null },
		],
		organizationMembers: [
			{ userId: "test-target", organizationId: "test-org", role: "member" },
			{ userId: "test-owner", organizationId: "test-org", role: "member" },
		],
		folders: [
			{
				id: "test-folder",
				createdById: "test-owner",
				organizationId: "test-org",
				spaceId: null,
				public: false,
				parentId: null,
				updatedAt: new Date("2025-01-01T00:00:00Z"),
			},
		],
		spaces: [],
		sharedVideos: [
			{
				id: "test-share",
				videoId: "test-video",
				organizationId: "test-org",
				folderId: "test-folder",
			},
		],
		spaceVideos: [
			{ id: "test-space-row", videoId: "test-video", folderId: "test-folder" },
		],
		agentApiOperations: [],
	};
});

async function prepare() {
	const preview = await previewRecordingOwnershipTransfer(request);
	if (!preview.ready)
		throw new Error(`Synthetic preview held: ${preview.reason}`);
	const input = {
		...request,
		requestId: "test-operation",
		previewToken: preview.previewToken,
	};
	await startRecordingOwnershipTransfer(input);
	return input;
}

describe("authenticated recording ownership operations", () => {
	it.each(["owner", "admin"])(
		"renders the operator caller for an active %s without issuing a challenge",
		async (role) => {
			if (role === "admin") {
				state.user = { id: "test-manager", activeOrganizationId: "test-org" };
				state.rows.organizationMembers?.push({
					userId: "test-manager",
					organizationId: "test-org",
					role: "admin",
				});
			}
			expect(await RecordingOwnershipPage()).toBeTruthy();
			expect(state.writes).toEqual([]);
			expect(state.start).not.toHaveBeenCalled();
		},
	);

	it.each([
		"signed-out",
		"no-organization",
		"member",
		"foreign-organization",
		"deleted-organization",
	])(
		"rejects %s access to the caller and direct challenge action",
		async (scenario) => {
			if (scenario === "signed-out") state.user = null;
			if (scenario === "no-organization")
				state.user = { id: "test-admin", activeOrganizationId: "" };
			if (scenario === "member")
				state.user = { id: "test-owner", activeOrganizationId: "test-org" };
			if (scenario === "foreign-organization")
				state.user = { id: "test-admin", activeOrganizationId: "test-other" };
			if (scenario === "deleted-organization")
				row("organizations").tombstoneAt = new Date();
			const signRead = vi.fn();
			media.store.signRead = signRead;
			await expect(RecordingOwnershipPage()).rejects.toThrow();
			await expect(
				prepareRecordingOwnershipPreflight(request),
			).rejects.toThrow();
			expect(signRead).not.toHaveBeenCalled();
			expect(state.writes).toEqual([]);
			expect(state.start).not.toHaveBeenCalled();
		},
	);

	it("preflights receipt-less web media, applies and rolls back without upload rows or processing", async () => {
		row("videos").source = { type: "webMP4" };
		row("videos").metadata = {};
		state.rows.videoUploads = [];
		state.rows.videoProcessingJobs = [];
		state.rows.videoEdits = [];
		state.rows.comments = [];
		media.objects.clear();
		media.objects.set(`${sourcePrefix}result.mp4`, {
			bytes: "synthetic-result",
			identity: '"synthetic-etag"',
		});
		media.store.head = async (key) => {
			const { sha256: _sha256, ...head } = await media.store.inspect(key);
			return { ...head, versionId: head.versionId ?? null };
		};
		media.store.signRead = async (key) => `https://storage.example.test/${key}`;
		const challenge = await prepareRecordingOwnershipPreflight(request);
		const secret = "synthetic-preflight-authentication-fixture-only";
		const parsed = openPreflight(
			"request",
			challenge.request,
			secret,
			preflightRequestSchema,
		);
		expect(state.writes).toEqual([]);
		const receipt = {
			policy: parsed.policy,
			context: parsed.context,
			manifestHash: preflightHash(parsed.manifest),
			requestHash: preflightRequestHash(parsed),
			issuedAt: Date.now(),
			expiresAt: Date.now() + 3600000,
			objects: await Promise.all(
				parsed.manifest.map(async (object) => ({
					ref: preflightHash(object.key),
					sha256: (await media.store.inspect(object.key)).sha256,
				})),
			),
			assets: parsed.assets.map((asset) => ({
				ref: asset.ref,
				decode: {
					fullDecode: true,
					video: { frameCount: 10, startTime: 0, endTime: 1, duration: 1 },
					audio: null,
					integrity: {
						video: {
							contentSha256: "a".repeat(64),
							timelineSha256: "b".repeat(64),
							format: "synthetic-video",
						},
						audio: null,
					},
				},
			})),
		};
		const input = {
			...request,
			preflightReceipt: sealPreflight("receipt", receipt, secret),
		};
		const preview = await previewRecordingOwnershipTransfer(input);
		if (!preview.ready) throw new Error("Synthetic preflight held");
		await startRecordingOwnershipTransfer({
			...input,
			previewToken: preview.previewToken,
			requestId: "test-operation",
		});
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-target");
		expect(state.rows.videoUploads).toEqual([]);
		expect(state.rows.videoProcessingJobs).toEqual([]);
		await rollbackRecordingOwnershipTransfer({
			operationId: "test-operation",
			dryRun: false,
		});
		expect(row("videos").ownerId).toBe("test-owner");
		expect(media.objects.has(`${sourcePrefix}result.mp4`)).toBe(true);
	});

	it("dry-runs without a journal, storage writes or workflow dispatch", async () => {
		const before = structuredClone(state.rows);
		expect((await previewRecordingOwnershipTransfer(request)).ready).toBe(true);
		expect(state.rows).toEqual(before);
		expect(state.writes).toEqual([]);
		expect(state.start).not.toHaveBeenCalled();
		expect(media.store.copyIfAbsent).not.toHaveBeenCalled();
	});

	it("commits verified media and preserves sharing, mixed folders, siblings and processing", async () => {
		const before = structuredClone(state.rows);
		const objects = structuredClone([...media.objects]);
		await prepare();
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-target");
		expect(row("videos").folderId).toBeNull();
		expect(row("videos").source).toMatchObject({
			outputKey: `${targetPrefix}.recording/outputs/test/result.mp4`,
		});
		expect(row("videoEdits").sourceKey).toBe(
			`${targetPrefix}source/original.mp4`,
		);
		expect(row("videoUploads").rawFileKey).toBe(
			`${targetPrefix}source/original.mp4`,
		);
		expect(row("comments")).toMatchObject({
			mediaKey: `${targetPrefix}comments/test-comment/media.webm`,
			mediaMeta: {
				thumbnailKey: `${targetPrefix}comments/test-comment/thumbnail.jpg`,
			},
			authorId: "test-author",
			content: "Synthetic comment",
		});
		expect(row("videos")).toMatchObject({
			public: false,
			password: "synthetic-password-hash",
			settings: { disableComments: false },
		});
		for (const table of [
			"sharedVideos",
			"spaceVideos",
			"folders",
			"videoProcessingJobs",
		])
			expect(state.rows[table]).toEqual(before[table]);
		expect(state.rows.videos?.[1]).toEqual(before.videos?.[1]);
		for (const [key, value] of objects)
			expect(media.objects.get(key)).toEqual(value);
		expect(row("videoUploads").phase).toBe("complete");
		expect(await getRecordingOwnershipTransfer("test-operation")).toMatchObject(
			{ state: "succeeded", phase: "applied" },
		);
	});

	it("rolls back atomically, retains both media copies, and makes repeat rollback a no-op", async () => {
		const before = structuredClone(state.rows);
		await prepare();
		await executeOwnershipTransfer("test-operation");
		const after = structuredClone(state.rows);
		const objects = structuredClone([...media.objects]);
		expect(
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: true,
			}),
		).toEqual({ phase: "ready" });
		expect(state.rows).toEqual(after);
		await rollbackRecordingOwnershipTransfer({
			operationId: "test-operation",
			dryRun: false,
		});
		for (const table of [
			"videos",
			"videoUploads",
			"videoEdits",
			"comments",
			"videoProcessingJobs",
			"sharedVideos",
			"spaceVideos",
			"folders",
		])
			expect(state.rows[table]).toEqual(before[table]);
		expect([...media.objects]).toEqual(objects);
		const writes = state.writes.length;
		expect(
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			}),
		).toEqual({ phase: "rolled_back" });
		expect(state.writes).toHaveLength(writes);
	});

	it("makes duplicate submissions and concurrent workers idempotent", async () => {
		const input = await prepare();
		await startRecordingOwnershipTransfer(input);
		expect(state.rows.agentApiOperations).toHaveLength(1);
		await Promise.all([
			executeOwnershipTransfer("test-operation"),
			executeOwnershipTransfer("test-operation"),
		]);
		expect(state.writes.filter((table) => table === "videos")).toHaveLength(1);
		const count = state.writes.length;
		await executeOwnershipTransfer("test-operation");
		expect(state.writes).toHaveLength(count);
	});

	it("rejects reuse of an operation id for a different request", async () => {
		const input = await prepare();
		await expect(
			startRecordingOwnershipTransfer({
				...input,
				previewToken: "a".repeat(64),
			}),
		).rejects.toThrow("conflicts");
	});

	it("holds stale previews and never starts an operation", async () => {
		const preview = await previewRecordingOwnershipTransfer(request);
		if (!preview.ready) throw new Error("Invalid fixture");
		row("videoEdits").editSpec = {
			version: 1,
			sourceDuration: 1,
			keepRanges: [{ start: 0, end: 0.5 }],
		};
		await expect(
			startRecordingOwnershipTransfer({
				...request,
				requestId: "test-operation",
				previewToken: preview.previewToken,
			}),
		).rejects.toThrow("SNAPSHOT_CHANGED");
		expect(state.rows.agentApiOperations).toHaveLength(0);
	});

	it("refuses publication when a concurrent edit wins during copying", async () => {
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async (...args) => {
			await copy(...args);
			row("videoUploads").phase = "processing";
		};
		await expect(executeOwnershipTransfer("test-operation")).rejects.toThrow(
			"NOT_READY",
		);
		expect(row("videos").ownerId).toBe("test-owner");
		expect(row("agentApiOperations").state).toBe("failed");
	});

	it("refuses rollback after a new edit or changed retained source", async () => {
		await prepare();
		await executeOwnershipTransfer("test-operation");
		const originalEdit = structuredClone(row("videoEdits"));
		row("videoEdits").sourceKey = `${targetPrefix}new-edit.mp4`;
		await expect(
			rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			}),
		).rejects.toThrow("SNAPSHOT_CHANGED");
		Object.assign(row("videoEdits"), originalEdit);
		media.objects.delete(
			`${sourcePrefix}.recording/outputs/test/thumbnail.jpg`,
		);
		await expect(
			rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			}),
		).rejects.toThrow("MEDIA_CHANGED");
		expect(row("videos").ownerId).toBe("test-target");
	});

	it("cancels an incomplete operation without removing partial copies", async () => {
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async (...args) => {
			await copy(...args);
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			});
		};
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-owner");
		expect(await getRecordingOwnershipTransfer("test-operation")).toMatchObject(
			{ phase: "cancelled" },
		);
		expect(
			[...media.objects.keys()].some((key) => key.startsWith(targetPrefix)),
		).toBe(true);
	});

	it("can resume a dispatch with an uncertain response", async () => {
		state.start.mockRejectedValueOnce(
			new Error("Synthetic dispatch response lost"),
		);
		await prepare();
		await retryRecordingOwnershipTransfer("test-operation");
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-target");
	});

	it("resumes after partial media failure without restarting processing", async () => {
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async () => {
			throw new Error("Synthetic storage failure");
		};
		await expect(executeOwnershipTransfer("test-operation")).rejects.toThrow();
		media.store.copyIfAbsent = copy;
		await retryRecordingOwnershipTransfer("test-operation");
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-target");
		expect(state.writes).not.toContain("videoProcessingJobs");
	});

	it("shares the organization lock with existing content transfers", async () => {
		state.rows.agentApiOperations = [
			{
				id: "test-active",
				kind: "transfer_org_content",
				resourceId: "test-org",
				state: "running",
			},
		];
		await expect(prepare()).rejects.toThrow("already running");
		expect(media.store.copyIfAbsent).not.toHaveBeenCalled();
	});

	it.each([
		"unauthenticated",
		"member",
		"other-organization",
		"missing-target",
	])("rejects %s access before media reads", async (mode) => {
		if (mode === "unauthenticated") state.user = null;
		if (mode === "member")
			state.user = { id: "test-owner", activeOrganizationId: "test-org" };
		if (mode === "other-organization")
			state.user = { id: "test-admin", activeOrganizationId: "test-other" };
		if (mode === "missing-target") state.rows.organizationMembers = [];
		await expect(previewRecordingOwnershipTransfer(request)).rejects.toThrow();
		expect(media.store.list).not.toHaveBeenCalled();
	});

	it("rechecks authorization before publication and rollback", async () => {
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async (...args) => {
			await copy(...args);
			state.rows.organizationMembers = [];
		};
		await expect(executeOwnershipTransfer("test-operation")).rejects.toThrow();
		expect(row("videos").ownerId).toBe("test-owner");
	});

	it("rejects a destination folder owned by another member", async () => {
		const result = await previewRecordingOwnershipTransfer({
			...request,
			destinationFolderId: "test-folder",
		});
		expect(result).toMatchObject({ ready: false, reason: "SNAPSHOT_CHANGED" });
	});
	it("transfers and rolls back qualified legacy media without fabricating an upload row", async () => {
		const legacy = legacyOwnershipFixture();
		Object.assign(row("videos"), legacy.video);
		state.rows.videoUploads = [];
		await prepare();
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-target");
		expect(state.rows.videoUploads).toEqual([]);
		expect(state.writes).not.toContain("videoUploads");
		await rollbackRecordingOwnershipTransfer({
			operationId: "test-operation",
			dryRun: false,
		});
		expect(row("videos").ownerId).toBe("test-owner");
		expect(state.rows.videoUploads).toEqual([]);
		expect(state.writes).not.toContain("videoUploads");
	});

	it("preserves a retired output-replaced guard without restarting original processing", async () => {
		Object.assign(row("videos"), legacyOwnershipFixture().video);
		state.rows.videoUploads = [];
		Object.assign(row("videoProcessingJobs"), {
			state: "source-blocked",
			errorCode: "output-replaced",
		});
		const original = structuredClone(row("videoProcessingJobs"));
		await prepare();
		await executeOwnershipTransfer("test-operation");
		expect(row("videoProcessingJobs")).toEqual(original);
		expect(state.writes).not.toContain("videoProcessingJobs");
		await rollbackRecordingOwnershipTransfer({
			operationId: "test-operation",
			dryRun: false,
		});
		expect(row("videoProcessingJobs")).toEqual(original);
	});

	it.each(["source-missing", "video-deleting", "source-reupload-required"])(
		"holds the %s processing guard",
		async (errorCode) => {
			Object.assign(row("videos"), legacyOwnershipFixture().video);
			state.rows.videoUploads = [];
			Object.assign(row("videoProcessingJobs"), {
				state: "source-blocked",
				errorCode,
			});
			expect(await previewRecordingOwnershipTransfer(request)).toMatchObject({
				ready: false,
				reason: "NOT_READY",
			});
			expect(state.writes).toEqual([]);
		},
	);

	it("binds absent-row completion evidence through the final publication transaction", async () => {
		Object.assign(row("videos"), legacyOwnershipFixture().video);
		state.rows.videoUploads = [];
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async (...args) => {
			await copy(...args);
			row("videos").metadata = null;
		};
		await expect(executeOwnershipTransfer("test-operation")).rejects.toThrow(
			"NOT_READY",
		);
		expect(row("videos").ownerId).toBe("test-owner");
		expect(state.rows.videoUploads).toEqual([]);
	});

	it("cancels a lost dispatch after the original owner leaves and releases transfer admission", async () => {
		state.start.mockRejectedValueOnce(
			new Error("Synthetic dispatch response lost"),
		);
		await prepare();
		state.rows.organizationMembers = (
			state.rows.organizationMembers ?? []
		).filter((member) => member.userId !== "test-owner");
		expect(
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: true,
			}),
		).toEqual({ phase: "ready" });
		expect(
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			}),
		).toEqual({ phase: "cancelled" });
		await executeOwnershipTransfer("test-operation");
		expect(row("videos").ownerId).toBe("test-owner");
		const preview = await previewRecordingOwnershipTransfer(request);
		if (!preview.ready) throw new Error("Invalid synthetic preview");
		await startRecordingOwnershipTransfer({
			...request,
			requestId: "test-next",
			previewToken: preview.previewToken,
		});
		expect(state.rows.agentApiOperations).toHaveLength(2);
	});

	it("still requires original-owner membership for post-publication rollback", async () => {
		await prepare();
		await executeOwnershipTransfer("test-operation");
		state.rows.organizationMembers = (
			state.rows.organizationMembers ?? []
		).filter((member) => member.userId !== "test-owner");
		await expect(
			rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			}),
		).rejects.toThrow("Forbidden");
		expect(row("videos").ownerId).toBe("test-target");
	});

	it.each(["public-personal", "organization", "space", "mixed-owner"])(
		"preserves and restores an unchanged %s original folder",
		async (kind) => {
			const folder = row("folders");
			if (kind === "public-personal") folder.public = true;
			if (kind === "organization") folder.spaceId = "test-org";
			if (kind === "mixed-owner") folder.createdById = "test-other";
			if (kind === "space") {
				folder.spaceId = "test-space";
				state.rows.spaces = [
					{
						id: "test-space",
						organizationId: "test-org",
						public: true,
						privacy: "Private",
						updatedAt: new Date("2025-01-01T00:00:00Z"),
					},
				];
			}
			const before = structuredClone(state.rows);
			await prepare();
			await executeOwnershipTransfer("test-operation");
			expect(row("videos").folderId).toBe(
				kind === "public-personal" ? "test-folder" : null,
			);
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			});
			expect(row("videos").folderId).toBe("test-folder");
			for (const table of ["folders", "spaces", "sharedVideos", "spaceVideos"])
				expect(state.rows[table]).toEqual(before[table]);
			expect(state.rows.videos?.[1]).toEqual(before.videos?.[1]);
		},
	);

	it.each(["deleted", "public", "parent", "space", "creator"])(
		"holds rollback after original folder %s changes",
		async (change) => {
			await prepare();
			await executeOwnershipTransfer("test-operation");
			if (change === "deleted") state.rows.folders = [];
			if (change === "public") row("folders").public = true;
			if (change === "parent") row("folders").parentId = "test-missing";
			if (change === "space") row("folders").spaceId = "test-missing";
			if (change === "creator") row("folders").createdById = "test-other";
			await expect(
				rollbackRecordingOwnershipTransfer({
					operationId: "test-operation",
					dryRun: false,
				}),
			).rejects.toThrow("SNAPSHOT_CHANGED");
			expect(row("videos").ownerId).toBe("test-target");
		},
	);

	it.each(["ancestor", "space"])(
		"holds rollback after original %s context changes",
		async (context) => {
			if (context === "ancestor") {
				state.rows.folders?.push({ ...row("folders"), id: "test-parent" });
				row("folders").parentId = "test-parent";
			} else {
				row("folders").spaceId = "test-space";
				state.rows.spaces = [
					{
						id: "test-space",
						organizationId: "test-org",
						public: true,
						privacy: "Private",
						updatedAt: new Date("2025-01-01T00:00:00Z"),
					},
				];
			}
			await prepare();
			await executeOwnershipTransfer("test-operation");
			if (context === "ancestor") {
				const parent = state.rows.folders?.find(
					(folder) => folder.id === "test-parent",
				);
				if (!parent) throw new Error("Missing synthetic parent");
				parent.public = true;
			} else row("spaces").privacy = "Public";
			await expect(
				rollbackRecordingOwnershipTransfer({
					operationId: "test-operation",
					dryRun: false,
				}),
			).rejects.toThrow("SNAPSHOT_CHANGED");
			expect(row("videos").ownerId).toBe("test-target");
		},
	);

	it("holds folder access changes during copying", async () => {
		await prepare();
		const copy = media.store.copyIfAbsent;
		media.store.copyIfAbsent = async (...args) => {
			await copy(...args);
			row("folders").public = true;
		};
		await expect(executeOwnershipTransfer("test-operation")).rejects.toThrow(
			"SNAPSHOT_CHANGED",
		);
		expect(row("videos").ownerId).toBe("test-owner");
	});
});
