import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { db } from "@cap/database";
import * as schema from "@cap/database/schema";
import { Folder, Organisation, Space, User, Video } from "@cap/web-domain";
import { applySwcTransform } from "@workflow/builders";
import { start as startLocalWorkflow } from "@workflow/core/runtime";
import { createLocalWorld } from "@workflow/world-local";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { transform } from "esbuild";
import { createPool } from "mysql2";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { registerStepFunction } from "workflow/internal/private";
import { setWorld, stepEntrypoint, workflowEntrypoint } from "workflow/runtime";
import type { OwnershipMediaStore } from "@/lib/recording-ownership-transfer";
import {
	mediaFixture,
	ownershipFixture,
	sourcePrefix,
	targetPrefix,
} from "../helpers/ownership-transfer";

const state = vi.hoisted(() => ({
	client: undefined as ReturnType<typeof db> | undefined,
	media: undefined as OwnershipMediaStore | undefined,
	dispatch: vi.fn(async () => ({})),
}));
vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_WEBHOOK_SECRET: "synthetic-integration-authentication-only",
	}),
}));
vi.mock("@cap/database", () => ({
	db: () => {
		if (!state.client) throw new Error("Synthetic database unavailable");
		return state.client;
	},
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => ({
		id: "test-admin",
		activeOrganizationId: "test-org",
	}),
}));
vi.mock("workflow/api", () => ({ start: state.dispatch }));
vi.mock("@/lib/workflow-runtime", async () => {
	const { Effect } = await import("effect");
	return { runWorkflowPromise: Effect.runPromise };
});
vi.mock("@/lib/recording-ownership-repository", async (original) => {
	const actual =
		await original<typeof import("@/lib/recording-ownership-repository")>();
	return {
		...actual,
		ownershipStore: async () => {
			if (!state.media) throw new Error("Synthetic storage unavailable");
			return state.media;
		},
	};
});

import {
	getRecordingOwnershipTransfer,
	previewRecordingOwnershipTransfer,
	rollbackRecordingOwnershipTransfer,
	startRecordingOwnershipTransfer,
} from "@/actions/organization/recording-ownership-transfer";
import {
	loadOwnershipSnapshot,
	requireOwnershipAccess,
} from "@/lib/recording-ownership-repository";
import { executeOwnershipTransfer } from "@/workflows/transfer-recording-ownership";

const enabled = process.env.CAP_OWNERSHIP_INTEGRATION === "synthetic";
const request = {
	videoId: "test-video",
	targetUserId: "test-target",
	destinationFolderId: null,
};
const owner = User.UserId.make("test-owner");
const videoId = Video.VideoId.make("test-video");
const org = Organisation.OrganisationId.make("test-org");
let pool: ReturnType<typeof createPool>;
let media: ReturnType<typeof mediaFixture>;
let workflowDirectory: string;

function client() {
	if (!state.client) throw new Error("Synthetic database unavailable");
	return state.client;
}
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
async function prepare(operationId = "test-operation") {
	const preview = await previewRecordingOwnershipTransfer(request);
	if (!preview.ready)
		throw new Error(`Synthetic preview held: ${preview.reason}`);
	const input = {
		...request,
		requestId: operationId,
		previewToken: preview.previewToken,
	};
	await startRecordingOwnershipTransfer(input);
	return input;
}
async function currentOwner() {
	const [row] = await client()
		.select({ ownerId: schema.videos.ownerId })
		.from(schema.videos)
		.where(eq(schema.videos.id, videoId));
	return row?.ownerId;
}

const tables = [
	schema.comments,
	schema.sharedVideos,
	schema.spaceVideos,
	schema.videoUploads,
	schema.videoEdits,
	schema.videoProcessingJobs,
	schema.agentApiOperations,
	schema.videos,
	schema.folders,
	schema.spaces,
	schema.organizationMembers,
	schema.organizations,
	schema.users,
];

describe.skipIf(!enabled)(
	"isolated MySQL recording ownership qualification",
	() => {
		beforeAll(async () => {
			const value = process.env.CAP_OWNERSHIP_TEST_DATABASE;
			if (!value) throw new Error("Missing synthetic database URL");
			const url = new URL(value);
			if (
				url.protocol !== "mysql:" ||
				url.hostname !== "127.0.0.1" ||
				!url.port ||
				url.pathname !== "/ownership_synthetic" ||
				url.username !== "synthetic" ||
				!/^synthetic_[a-f0-9]{40}$/.test(url.password)
			)
				throw new Error("Refusing non-synthetic database");
			pool = createPool({ uri: value, connectionLimit: 8, timezone: "Z" });
			state.client = drizzle(pool);
			let connected = false;
			for (let attempt = 0; attempt < 60; attempt++) {
				try {
					await pool.promise().query("SELECT 1");
					connected = true;
					break;
				} catch {
					await new Promise((resolve) => setTimeout(resolve, 500));
				}
			}
			if (!connected) throw new Error("Synthetic MySQL did not become ready");
			await promisify(execFile)(
				"bun",
				[
					"--no-env-file",
					"-e",
					`
				import * as schema from "@cap/database/schema";
				import { generateMySQLDrizzleJson, generateMySQLMigration } from "drizzle-kit/api";
				import { createPool } from "mysql2/promise";
				const pool = createPool(process.env.CAP_OWNERSHIP_TEST_DATABASE);
				try {
					const snapshot = await generateMySQLDrizzleJson(schema);
					const [tables] = await pool.query("SHOW TABLES");
					if (tables.length === 0) {
						const empty = await generateMySQLDrizzleJson({});
						for (const statement of await generateMySQLMigration(empty, snapshot)) await pool.query(statement);
					} else if (tables.length !== Object.keys(snapshot.tables).length) throw new Error("Unexpected synthetic schema");
				} finally { await pool.end(); }
			`,
				],
				{
					cwd: resolve("../.."),
					env: {
						NODE_ENV: "test",
						PATH: process.env.PATH,
						CAP_OWNERSHIP_TEST_DATABASE: value,
					},
					timeout: 30000,
				},
			);
			workflowDirectory = await mkdtemp(
				join(tmpdir(), "ownership-workflow-synthetic-"),
			);
		}, 60000);
		afterAll(async () => {
			setWorld(undefined);
			await pool?.promise().end();
			if (workflowDirectory)
				await rm(workflowDirectory, { recursive: true, force: true });
		});
		beforeEach(async () => {
			for (const table of tables) await client().delete(table);
			const fixture = ownershipFixture();
			await client()
				.insert(schema.users)
				.values(
					["test-admin", "test-owner", "test-target"].map((id) => ({
						id: User.UserId.make(id),
						email: `${id}@example.test`,
						activeOrganizationId: org,
					})),
				);
			await client()
				.insert(schema.organizations)
				.values({
					id: org,
					name: "Synthetic organization",
					ownerId: User.UserId.make("test-admin"),
				});
			await client()
				.insert(schema.organizationMembers)
				.values(
					["test-owner", "test-target"].map((id, index) => ({
						id: `test-member-${index}`,
						userId: User.UserId.make(id),
						organizationId: org,
						role: "member" as const,
					})),
				);
			await client()
				.insert(schema.spaces)
				.values({
					id: Space.SpaceId.make("test-space"),
					name: "Synthetic space",
					organizationId: org,
					createdById: owner,
				});
			await client()
				.insert(schema.folders)
				.values({
					id: Folder.FolderId.make("test-folder"),
					name: "Synthetic mixed folder",
					organizationId: org,
					createdById: owner,
				});
			const video = {
				...fixture.video,
				source: { type: "webMP4" as const },
				metadata: {},
				name: "Synthetic recording",
			};
			await client()
				.insert(schema.videos)
				.values([video, { ...video, id: Video.VideoId.make("test-sibling") }]);
			if (!fixture.upload || !fixture.edit)
				throw new Error("Missing synthetic state");
			await client().insert(schema.videoUploads).values(fixture.upload);
			await client().insert(schema.videoEdits).values(fixture.edit);
			await client()
				.insert(schema.comments)
				.values(
					fixture.comments.map((comment) => ({
						...comment,
						videoId,
						authorId: owner,
						content: "Synthetic comment",
						type: "text" as const,
					})),
				);
			await client()
				.insert(schema.sharedVideos)
				.values({
					id: "test-share",
					videoId,
					organizationId: org,
					folderId: Folder.FolderId.make("test-folder"),
					sharedByUserId: owner,
				});
			await client()
				.insert(schema.spaceVideos)
				.values({
					id: "test-space-row",
					videoId,
					spaceId: Space.SpaceId.make("test-space"),
					folderId: Folder.FolderId.make("test-folder"),
					addedById: owner,
				});
			media = mediaFixture();
			media.objects.set(`${sourcePrefix}result.mp4`, {
				bytes: "synthetic-0",
				identity: '"test-result"',
			});
			state.media = media.store;
		});

		it("commits and rolls back all ownership fields while preserving sharing and originals", async () => {
			const before = await loadOwnershipSnapshot(client(), "test-video");
			const shared = await client().select().from(schema.sharedVideos);
			const spaces = await client().select().from(schema.spaceVideos);
			await prepare();
			await executeOwnershipTransfer("test-operation");
			expect(await currentOwner()).toBe("test-target");
			const after = await loadOwnershipSnapshot(client(), "test-video");
			expect(after.edit?.sourceKey).toBe(`${targetPrefix}source/original.mp4`);
			expect(after.comments[0]?.mediaKey).toContain(targetPrefix);
			expect(await client().select().from(schema.sharedVideos)).toEqual(shared);
			expect(await client().select().from(schema.spaceVideos)).toEqual(spaces);
			await rollbackRecordingOwnershipTransfer({
				operationId: "test-operation",
				dryRun: false,
			});
			expect(await currentOwner()).toBe("test-owner");
			expect(
				(await loadOwnershipSnapshot(client(), "test-video")).video.source,
			).toEqual(before.video.source);
			expect(media.objects.has(`${sourcePrefix}result.mp4`)).toBe(true);
		});

		it("serializes concurrent starts with the organization row lock", async () => {
			const preview = await previewRecordingOwnershipTransfer(request);
			if (!preview.ready) throw new Error("Synthetic preview held");
			const results = await Promise.allSettled(
				["test-start-a", "test-start-b"].map((requestId) =>
					startRecordingOwnershipTransfer({
						...request,
						requestId,
						previewToken: preview.previewToken,
					}),
				),
			);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				await client().select().from(schema.agentApiOperations),
			).toHaveLength(1);
		});

		it("publishes once when two workers copy and commit concurrently", async () => {
			await prepare();
			const entered = gate();
			const release = gate();
			let calls = 0;
			const copy = media.store.copyIfAbsent;
			media.store.copyIfAbsent = async (...args) => {
				if (++calls === 2) entered.resolve();
				await release.promise;
				return copy(...args);
			};
			const workers = [
				executeOwnershipTransfer("test-operation"),
				executeOwnershipTransfer("test-operation"),
			];
			await entered.promise;
			release.resolve();
			await Promise.all(workers);
			expect(await currentOwner()).toBe("test-target");
			expect(
				(await getRecordingOwnershipTransfer("test-operation")).state,
			).toBe("succeeded");
			expect(
				await client().select().from(schema.agentApiOperations),
			).toHaveLength(1);
		});

		it("holds publication when a concurrent SQL edit changes the snapshot", async () => {
			await prepare();
			const entered = gate();
			const release = gate();
			const copy = media.store.copyIfAbsent;
			media.store.copyIfAbsent = async (...args) => {
				entered.resolve();
				await release.promise;
				return copy(...args);
			};
			const worker = executeOwnershipTransfer("test-operation");
			await entered.promise;
			try {
				await client()
					.update(schema.videos)
					.set({ metadata: { summary: "Synthetic concurrent edit" } })
					.where(eq(schema.videos.id, videoId));
			} finally {
				release.resolve();
			}
			await expect(worker).rejects.toThrow("SNAPSHOT_CHANGED");
			expect(await currentOwner()).toBe("test-owner");
		});

		it("rolls back earlier SQL writes when a later publication write fails", async () => {
			await prepare();
			await client().execute(
				sql.raw(
					"CREATE TRIGGER synthetic_reject_comment BEFORE UPDATE ON comments FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'synthetic failure'",
				),
			);
			try {
				await expect(
					executeOwnershipTransfer("test-operation"),
				).rejects.toThrow();
			} finally {
				await client().execute(
					sql.raw("DROP TRIGGER synthetic_reject_comment"),
				);
			}
			expect(await currentOwner()).toBe("test-owner");
			expect(
				(await loadOwnershipSnapshot(client(), "test-video")).edit?.sourceKey,
			).toBe(`${sourcePrefix}source/original.mp4`);
			expect(
				(await getRecordingOwnershipTransfer("test-operation")).state,
			).toBe("failed");
		});

		it("makes an independent connection wait for the real organization lock", async () => {
			const entered = gate();
			const release = gate();
			const holder = client().transaction(async (tx) => {
				await requireOwnershipAccess(
					tx,
					"test-org",
					"test-admin",
					"test-target",
					true,
				);
				entered.resolve();
				await release.promise;
			});
			await entered.promise;
			let completed = false;
			const contender = client().transaction(async (tx) => {
				await requireOwnershipAccess(
					tx,
					"test-org",
					"test-admin",
					"test-target",
					true,
				);
				completed = true;
			});
			try {
				await new Promise((resolve) => setTimeout(resolve, 150));
				expect(completed).toBe(false);
			} finally {
				release.resolve();
			}
			await Promise.all([holder, contender]);
			expect(completed).toBe(true);
		});

		it("cancels while a worker copies and prevents stale publication", async () => {
			await prepare();
			const entered = gate();
			const release = gate();
			const copy = media.store.copyIfAbsent;
			media.store.copyIfAbsent = async (...args) => {
				entered.resolve();
				await release.promise;
				return copy(...args);
			};
			const worker = executeOwnershipTransfer("test-operation");
			await entered.promise;
			try {
				expect(
					(
						await rollbackRecordingOwnershipTransfer({
							operationId: "test-operation",
							dryRun: false,
						})
					).phase,
				).toBe("cancelled");
			} finally {
				release.resolve();
			}
			await worker;
			expect(await currentOwner()).toBe("test-owner");
			expect(
				(await getRecordingOwnershipTransfer("test-operation")).phase,
			).toBe("cancelled");
		});

		it("serializes concurrent rollback and repeated completed workers", async () => {
			await prepare();
			await executeOwnershipTransfer("test-operation");
			const results = await Promise.all([
				rollbackRecordingOwnershipTransfer({
					operationId: "test-operation",
					dryRun: false,
				}),
				rollbackRecordingOwnershipTransfer({
					operationId: "test-operation",
					dryRun: false,
				}),
			]);
			expect(results.every((result) => result.phase === "rolled_back")).toBe(
				true,
			);
			await executeOwnershipTransfer("test-operation");
			expect(await currentOwner()).toBe("test-owner");
		});

		it("executes the actual workflow through local durable step handlers", async () => {
			await prepare();
			const file = resolve("workflows/transfer-recording-ownership.ts");
			const transformed = await applySwcTransform(
				"workflows/transfer-recording-ownership.ts",
				await readFile(file, "utf8"),
				"workflow",
				file,
				process.cwd(),
			);
			const workflow = Object.values(
				transformed.workflowManifest.workflows ?? {},
			).flatMap(Object.values)[0];
			const step = Object.values(
				transformed.workflowManifest.steps ?? {},
			).flatMap(Object.values)[0];
			if (!workflow || !step)
				throw new Error("Missing synthetic workflow registration");
			const code = await transform(
				`globalThis.__private_workflows = new Map();\n${transformed.code}`,
				{
					format: "iife",
					target: "esnext",
				},
			);
			const world = createLocalWorld({
				dataDir: workflowDirectory,
				recoverActiveRuns: false,
			});
			setWorld(world);
			registerStepFunction(step.stepId, executeOwnershipTransfer);
			world.registerHandler("__wkf_step_", stepEntrypoint);
			world.registerHandler("__wkf_workflow_", workflowEntrypoint(code.code));
			await world.start?.();
			try {
				const run = await startLocalWorkflow(
					{ workflowId: workflow.workflowId },
					[{ operationId: "test-operation" }],
					{ world },
				);
				await run.returnValue;
				expect(await currentOwner()).toBe("test-target");
				expect(await run.status).toBe("completed");
			} finally {
				await world.close?.();
				setWorld(undefined);
			}
		}, 30000);
	},
);
