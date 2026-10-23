import { randomUUID } from "node:crypto";
import { db } from "@cap/database";
import {
	importedVideos,
	loomMigrationImports,
	loomMigrationRequests,
	organizationMembers,
	organizations,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import {
	Organisation,
	type Storage as StorageDomain,
	User,
	Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { createConnection } from "mysql2/promise";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import {
	type LoomMigrationResult,
	unwrapLoomMigrationResult,
} from "@/lib/loom-migration-state";

const databaseUrl = process.env.CAP_LOOM_CONCIERGE_TEST_DATABASE_URL;

const fixture = vi.hoisted(() => {
	const url = process.env.CAP_LOOM_CONCIERGE_TEST_DATABASE_URL;
	if (url) process.env.DATABASE_URL = url;
	return {
		currentUserId: null as string | null,
		sendEmail: vi.fn(async (_input: unknown) => ({})),
		start: vi.fn(async (_workflow: unknown, _args: unknown) => ({
			runId: "run_fixture",
		})),
	};
});

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({
	cookies: async () => ({ get: () => undefined }),
	headers: async () => new Headers(),
}));
vi.mock("workflow/api", () => ({ start: fixture.start }));
vi.mock("@cap/database/emails/config", () => ({
	sendEmail: fixture.sendEmail,
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: async () => {
		if (!fixture.currentUserId) return null;
		const [user] = await db()
			.select()
			.from(users)
			.where(eq(users.id, User.UserId.make(fixture.currentUserId)))
			.limit(1);
		return user ?? null;
	},
}));

const OPERATOR_EMAIL = "richie@cap.so";
const realFetch = globalThis.fetch;

type StorageUploadTarget = StorageDomain.UploadTarget;

function id() {
	return randomUUID().replaceAll("-", "").slice(0, 15);
}

function loomId() {
	return randomUUID().replaceAll("-", "");
}

function unwrapped<Args extends unknown[], T>(
	action: (...args: Args) => Promise<LoomMigrationResult<T>>,
) {
	return async (...args: Args) =>
		unwrapLoomMigrationResult(await action(...args));
}

function signInAs(userId: string | null) {
	fixture.currentUserId = userId;
}

async function makeUser({
	email = `${id()}@example.com`,
	pro = false,
	activeOrganizationId = Organisation.OrganisationId.make(id()),
}: {
	email?: string;
	pro?: boolean;
	activeOrganizationId?: Organisation.OrganisationId;
} = {}) {
	const userId = User.UserId.make(id());
	await db()
		.insert(users)
		.values({
			id: userId,
			email,
			activeOrganizationId,
			stripeSubscriptionStatus: pro ? "active" : null,
			stripeSubscriptionId: pro ? `sub_fixture_${id()}` : null,
		});
	return userId;
}

async function makeOrganization({
	pro = true,
	privateByDefault = false,
}: {
	pro?: boolean;
	privateByDefault?: boolean;
} = {}) {
	const organizationId = Organisation.OrganisationId.make(id());
	const ownerId = await makeUser({ pro, activeOrganizationId: organizationId });
	await db()
		.insert(organizations)
		.values({
			id: organizationId,
			ownerId,
			name: "Concierge fixture",
			defaultVideoVisibility: privateByDefault ? "private" : null,
		});
	await db().insert(organizationMembers).values({
		id: id(),
		userId: ownerId,
		organizationId,
		role: "owner",
	});
	return { ownerId, organizationId };
}

async function addMember(
	organizationId: Organisation.OrganisationId,
	role: "member" | "admin",
) {
	const userId = await makeUser();
	await db().insert(organizationMembers).values({
		id: id(),
		userId,
		organizationId,
		role,
	});
	return userId;
}

async function getOperatorId() {
	const [existing] = await db()
		.select({ id: users.id })
		.from(users)
		.where(eq(users.email, OPERATOR_EMAIL))
		.limit(1);
	return existing?.id ?? (await makeUser({ email: OPERATOR_EMAIL }));
}

async function getRequest(requestId: string) {
	const [request] = await db()
		.select()
		.from(loomMigrationRequests)
		.where(eq(loomMigrationRequests.id, requestId))
		.limit(1);
	if (!request) throw new Error("Missing request fixture");
	return request;
}

async function setUploadPhase(
	videoId: string,
	phase: "uploading" | "processing" | "complete" | "error",
) {
	await db()
		.update(videoUploads)
		.set({ phase })
		.where(eq(videoUploads.videoId, Video.VideoId.make(videoId)));
}

async function uploadToTarget(target: StorageUploadTarget) {
	const body = new Uint8Array(4096).fill(7);
	if (target.type === "put") {
		const response = await realFetch(target.url, {
			method: "PUT",
			headers: target.headers,
			body,
		});
		expect(response.ok).toBe(true);
	} else if (target.type === "s3Post") {
		const form = new FormData();
		for (const [key, value] of Object.entries(target.fields)) {
			form.append(key, value);
		}
		form.append("file", new Blob([body], { type: "video/mp4" }));
		const response = await realFetch(target.url, {
			method: "POST",
			body: form,
		});
		expect(response.ok).toBe(true);
	} else {
		throw new Error(`Unexpected upload target ${target.type}`);
	}
}

function stubLoomFetch() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input.toString();
			if (url.includes("/transcoded-url") || url.includes("/raw-url")) {
				return new Response(
					JSON.stringify({ url: "https://cdn.loom.com/sessions/video.mp4" }),
					{ status: 200 },
				);
			}
			if (url.startsWith("https://www.loom.com/graphql")) {
				return Response.json({ data: { getVideo: { name: "Loom fixture" } } });
			}
			if (url.startsWith("https://www.loom.com/v1/oembed")) {
				return Response.json({ duration: 12, width: 1280, height: 720 });
			}
			return realFetch(input, init);
		}),
	);
}

describe.skipIf(!databaseUrl)("Loom concierge migration database", () => {
	let rawActions: typeof import("@/actions/loom-concierge");
	let rawLoom: typeof import("@/actions/loom");
	let operatorId: User.UserId;

	const actions = {
		getLoomMigrationDashboard: (
			...args: Parameters<typeof rawActions.getLoomMigrationDashboard>
		) => rawActions.getLoomMigrationDashboard(...args),
		getLoomMigrationOperatorQueue: () =>
			rawActions.getLoomMigrationOperatorQueue(),
		requestLoomMigration: unwrapped(
			(...args: Parameters<typeof rawActions.requestLoomMigration>) =>
				rawActions.requestLoomMigration(...args),
		),
		confirmLoomMigrationInvite: unwrapped((requestId: string) =>
			rawActions.confirmLoomMigrationInvite(requestId),
		),
		answerLoomMigrationQuestion: unwrapped(
			(...args: Parameters<typeof rawActions.answerLoomMigrationQuestion>) =>
				rawActions.answerLoomMigrationQuestion(...args),
		),
		updateLoomMigrationStatus: unwrapped(
			(...args: Parameters<typeof rawActions.updateLoomMigrationStatus>) =>
				rawActions.updateLoomMigrationStatus(...args),
		),
		reconcileLoomMigrationInventory: unwrapped(
			(
				...args: Parameters<typeof rawActions.reconcileLoomMigrationInventory>
			) => rawActions.reconcileLoomMigrationInventory(...args),
		),
	};
	const loom = {
		importFromLoomCsvForConcierge: unwrapped(
			(...args: Parameters<typeof rawLoom.importFromLoomCsvForConcierge>) =>
				rawLoom.importFromLoomCsvForConcierge(...args),
		),
		createConciergeLoomFileUpload: unwrapped(
			(...args: Parameters<typeof rawLoom.createConciergeLoomFileUpload>) =>
				rawLoom.createConciergeLoomFileUpload(...args),
		),
		finishConciergeLoomFileUpload: unwrapped(
			(...args: Parameters<typeof rawLoom.finishConciergeLoomFileUpload>) =>
				rawLoom.finishConciergeLoomFileUpload(...args),
		),
	};

	beforeAll(async () => {
		rawActions = await import("@/actions/loom-concierge");
		rawLoom = await import("@/actions/loom");
		operatorId = await getOperatorId();
	});

	beforeEach(() => {
		signInAs(null);
		stubLoomFetch();
	});

	afterAll(() => {
		vi.unstubAllGlobals();
	});

	async function requestMigration(
		organizationId: Organisation.OrganisationId,
		ownerId: User.UserId,
	) {
		signInAs(ownerId);
		const result = await actions.requestLoomMigration({
			organizationId,
			workspaceName: "  Acme   Loom  ",
			note: "Two workspaces",
		});
		return result.id;
	}

	it("lets a Pro organization manager request one active migration", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		signInAs(ownerId);
		const first = await actions.requestLoomMigration({
			organizationId,
			workspaceName: "  Acme   Loom  ",
			note: "",
		});
		const second = await actions.requestLoomMigration({
			organizationId,
			workspaceName: "Again",
			note: "",
		});

		expect(first.alreadyRequested).toBe(false);
		expect(second).toEqual({ id: first.id, alreadyRequested: true });
		const request = await getRequest(first.id);
		expect(request.workspaceName).toBe("Acme Loom");
		expect(request.status).toBe("pending");
		expect(request.activeOrganizationId).toBe(organizationId);
		expect(fixture.sendEmail).toHaveBeenCalledTimes(1);
		expect(fixture.sendEmail.mock.calls[0]?.[0]).toMatchObject({
			email: "hello@cap.so",
		});

		const dashboard = await actions.getLoomMigrationDashboard(organizationId);
		expect(dashboard.isPro).toBe(true);
		expect(dashboard.requests.map((item) => item.id)).toEqual([first.id]);
	});

	it("rejects free organizations, members, outsiders, and signed-out users", async () => {
		const free = await makeOrganization({ pro: false });
		signInAs(free.ownerId);
		await expect(
			actions.requestLoomMigration({
				organizationId: free.organizationId,
				workspaceName: "",
				note: "",
			}),
		).rejects.toThrow("requires Cap Pro");

		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		const member = await addMember(organizationId, "member");
		signInAs(member);
		await expect(
			actions.getLoomMigrationDashboard(organizationId),
		).rejects.toThrow();
		await expect(
			actions.confirmLoomMigrationInvite(requestId),
		).rejects.toThrow();

		const outsider = await makeOrganization();
		signInAs(outsider.ownerId);
		await expect(
			actions.getLoomMigrationDashboard(organizationId),
		).rejects.toThrow();
		await expect(
			actions.confirmLoomMigrationInvite(requestId),
		).rejects.toThrow();
		await expect(
			actions.answerLoomMigrationQuestion({ requestId, answer: "hi" }),
		).rejects.toThrow();

		signInAs(null);
		await expect(actions.confirmLoomMigrationInvite(requestId)).rejects.toThrow(
			"Unauthorized",
		);

		const admin = await addMember(organizationId, "admin");
		signInAs(admin);
		await actions.confirmLoomMigrationInvite(requestId);
		expect((await getRequest(requestId)).invitedAt).not.toBeNull();
	});

	it("limits every operator action to the Cap operator account", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		signInAs(ownerId);
		await expect(actions.getLoomMigrationOperatorQueue()).rejects.toThrow(
			"Unauthorized",
		);
		await expect(
			actions.updateLoomMigrationStatus({
				requestId,
				nextStatus: "in_progress",
				message: "",
				verified: false,
				expectedVideoCount: null,
				importedVideoCount: 0,
			}),
		).rejects.toThrow("Unauthorized");
		await expect(
			loom.importFromLoomCsvForConcierge({ requestId, rows: [] }),
		).rejects.toThrow("Unauthorized");
		await expect(
			loom.createConciergeLoomFileUpload({
				requestId,
				loomUrl: `https://www.loom.com/share/${loomId()}`,
				userEmail: "someone@example.com",
				spaceName: "",
				videoTitle: "Title",
			}),
		).rejects.toThrow("Unauthorized");
		await expect(
			loom.finishConciergeLoomFileUpload({
				requestId,
				videoId: Video.VideoId.make(id()),
			}),
		).rejects.toThrow("Unauthorized");

		signInAs(operatorId);
		const queue = await actions.getLoomMigrationOperatorQueue();
		expect(queue.find((item) => item.id === requestId)).toMatchObject({
			organizationName: "Concierge fixture",
			status: "pending",
		});
	});

	it("returns expected failures as data so production clients can show them", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		signInAs(operatorId);
		await expect(
			rawActions.updateLoomMigrationStatus({
				requestId,
				nextStatus: "completed",
				message: "",
				verified: false,
				expectedVideoCount: 1,
				importedVideoCount: 1,
			}),
		).resolves.toEqual({
			ok: false,
			error: "Verify the migrated library before marking it complete.",
		});
		await expect(
			rawLoom.finishConciergeLoomFileUpload({
				requestId: "not-a-request",
				videoId: Video.VideoId.make(id()),
			}),
		).resolves.toEqual({ ok: false, error: "Invalid migration request." });

		signInAs(ownerId);
		await expect(
			rawLoom.importFromLoomCsvForConcierge({ requestId, rows: [] }),
		).resolves.toEqual({ ok: false, error: "Unauthorized" });
	});

	it("keeps an open customer question while imports run and only emails visible changes", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		signInAs(operatorId);
		await actions.updateLoomMigrationStatus({
			requestId,
			nextStatus: "needs_information",
			message: "Please share the Sales folder",
			verified: false,
			expectedVideoCount: null,
			importedVideoCount: 0,
		});
		await loom.importFromLoomCsvForConcierge({
			requestId,
			rows: [
				{
					rowNumber: 2,
					loomUrl: `https://www.loom.com/share/${loomId()}`,
					userEmail: `${id()}@example.com`,
					spaceName: "",
				},
			],
		});
		expect((await getRequest(requestId)).status).toBe("needs_information");

		fixture.sendEmail.mockClear();
		await actions.updateLoomMigrationStatus({
			requestId,
			nextStatus: "needs_information",
			message: "Please share the Sales folder",
			verified: false,
			expectedVideoCount: 5,
			importedVideoCount: 1,
		});
		expect(fixture.sendEmail).not.toHaveBeenCalled();
		expect((await getRequest(requestId)).expectedVideoCount).toBe(5);

		signInAs(ownerId);
		await actions.answerLoomMigrationQuestion({
			requestId,
			answer: "Shared it",
		});
		expect((await getRequest(requestId)).status).toBe("pending");
	});

	it("round-trips an information request with the customer", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		signInAs(operatorId);
		await expect(
			actions.updateLoomMigrationStatus({
				requestId,
				nextStatus: "needs_information",
				message: "   ",
				verified: false,
				expectedVideoCount: null,
				importedVideoCount: 0,
			}),
		).rejects.toThrow("what information you need");
		await actions.updateLoomMigrationStatus({
			requestId,
			nextStatus: "needs_information",
			message: "Which Loom workspace?",
			verified: false,
			expectedVideoCount: null,
			importedVideoCount: 0,
		});

		signInAs(ownerId);
		await actions.answerLoomMigrationQuestion({
			requestId,
			answer: "The Acme one",
		});
		const answered = await getRequest(requestId);
		expect(answered.status).toBe("pending");
		expect(answered.customerReply).toBe("The Acme one");
		await expect(
			actions.answerLoomMigrationQuestion({ requestId, answer: "Again" }),
		).rejects.toThrow("changed");
	});

	it("imports CSV rows into the customer workspace under the request", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);
		const firstRow = {
			rowNumber: 2,
			loomUrl: `https://www.loom.com/share/${loomId()}`,
			userEmail: `${id()}@example.com`,
			spaceName: "Sales",
		};
		const rows = [
			firstRow,
			{
				rowNumber: 3,
				loomUrl: `https://www.loom.com/share/${loomId()}`,
				userEmail: `${id()}@example.com`,
				spaceName: "",
			},
		];

		signInAs(operatorId);
		await expect(
			loom.importFromLoomCsvForConcierge({
				requestId,
				rows: Array.from({ length: 11 }, () => firstRow),
			}),
		).rejects.toThrow("batches of 10");

		const result = await loom.importFromLoomCsvForConcierge({
			requestId,
			rows,
		});
		expect(result.importedCount).toBe(2);
		expect(fixture.start).toHaveBeenCalledTimes(2);

		const mapped = await db()
			.select({ videoId: loomMigrationImports.videoId, orgId: videos.orgId })
			.from(loomMigrationImports)
			.innerJoin(videos, eq(videos.id, loomMigrationImports.videoId))
			.where(eq(loomMigrationImports.requestId, requestId));
		expect(mapped).toHaveLength(2);
		expect(mapped.every((row) => row.orgId === organizationId)).toBe(true);

		const request = await getRequest(requestId);
		expect(request.queuedVideoCount).toBe(2);
		expect(request.status).toBe("in_progress");
		expect(request.activeImportCount).toBe(0);
		expect(request.activeImportLeaseToken).toBeNull();

		const repeat = await loom.importFromLoomCsvForConcierge({
			requestId,
			rows: [firstRow],
		});
		expect(repeat.importedCount).toBe(0);
		expect((await getRequest(requestId)).queuedVideoCount).toBe(2);
	});

	it("serializes imports and recovers expired reservations", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);
		const row = {
			rowNumber: 2,
			loomUrl: `https://www.loom.com/share/${loomId()}`,
			userEmail: `${id()}@example.com`,
			spaceName: "",
		};

		await db()
			.update(loomMigrationRequests)
			.set({
				activeImportCount: 1,
				activeImportLeaseToken: randomUUID(),
				activeImportLeaseUntil: new Date(Date.now() + 60_000),
			})
			.where(eq(loomMigrationRequests.id, requestId));

		signInAs(operatorId);
		await expect(
			loom.importFromLoomCsvForConcierge({ requestId, rows: [row] }),
		).rejects.toThrow("another import is starting");
		await expect(
			actions.updateLoomMigrationStatus({
				requestId,
				nextStatus: "completed",
				message: "",
				verified: true,
				expectedVideoCount: 0,
				importedVideoCount: 0,
			}),
		).rejects.toThrow("imports are starting");

		await db()
			.update(loomMigrationRequests)
			.set({ activeImportLeaseUntil: new Date(Date.now() - 1_000) })
			.where(eq(loomMigrationRequests.id, requestId));
		const result = await loom.importFromLoomCsvForConcierge({
			requestId,
			rows: [row],
		});
		expect(result.importedCount).toBe(1);
		expect((await getRequest(requestId)).activeImportLeaseToken).toBeNull();
	});

	it("only completes reconciled requests with finished imports", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);

		signInAs(operatorId);
		await loom.importFromLoomCsvForConcierge({
			requestId,
			rows: [
				{
					rowNumber: 2,
					loomUrl: `https://www.loom.com/share/${loomId()}`,
					userEmail: `${id()}@example.com`,
					spaceName: "",
				},
			],
		});
		const [mapped] = await db()
			.select({ videoId: loomMigrationImports.videoId })
			.from(loomMigrationImports)
			.where(eq(loomMigrationImports.requestId, requestId));
		if (!mapped) throw new Error("Missing mapped import");

		const complete = {
			requestId,
			nextStatus: "completed" as const,
			message: "All done",
			verified: true,
			expectedVideoCount: 1,
			importedVideoCount: 1,
		};
		await expect(
			actions.updateLoomMigrationStatus({ ...complete, verified: false }),
		).rejects.toThrow("Verify");
		await expect(
			actions.updateLoomMigrationStatus({
				...complete,
				expectedVideoCount: null,
			}),
		).rejects.toThrow("agreed source video count");
		await expect(
			actions.updateLoomMigrationStatus({ ...complete, expectedVideoCount: 2 }),
		).rejects.toThrow("Reconcile");

		for (const phase of ["uploading", "processing", "error"] as const) {
			await setUploadPhase(mapped.videoId, phase);
			await expect(actions.updateLoomMigrationStatus(complete)).rejects.toThrow(
				"still processing",
			);
		}

		const unrelated = await makeOrganization();
		signInAs(unrelated.ownerId);
		const unrelatedRequest = await requestMigration(
			unrelated.organizationId,
			unrelated.ownerId,
		);
		expect(unrelatedRequest).not.toBe(requestId);

		signInAs(operatorId);
		await setUploadPhase(mapped.videoId, "complete");
		fixture.sendEmail.mockClear();
		await actions.updateLoomMigrationStatus(complete);

		const completed = await getRequest(requestId);
		expect(completed.status).toBe("completed");
		expect(completed.activeOrganizationId).toBeNull();
		expect(completed.completedAt).not.toBeNull();
		expect(fixture.sendEmail).toHaveBeenCalledTimes(1);

		await expect(
			actions.updateLoomMigrationStatus({
				...complete,
				nextStatus: "in_progress",
			}),
		).rejects.toThrow("cannot be changed");
		await expect(
			loom.importFromLoomCsvForConcierge({ requestId, rows: [] }),
		).rejects.toThrow("no longer active");

		const queue = await actions.getLoomMigrationOperatorQueue();
		expect(queue.some((item) => item.id === requestId)).toBe(false);

		signInAs(ownerId);
		const reopened = await actions.requestLoomMigration({
			organizationId,
			workspaceName: "",
			note: "One more workspace",
		});
		expect(reopened.alreadyRequested).toBe(false);
		expect(reopened.id).not.toBe(requestId);
	});

	it.each(["recording", "source mapping"])(
		"does not complete or notify when a migrated %s disappears",
		async (missing) => {
			const { ownerId, organizationId } = await makeOrganization();
			const requestId = await requestMigration(organizationId, ownerId);
			const videoId = Video.VideoId.make(id());
			await db().insert(videos).values({
				id: videoId,
				name: "Finished import",
				ownerId,
				orgId: organizationId,
			});
			await db().insert(importedVideos).values({
				id: videoId,
				orgId: organizationId,
				source: "loom",
				sourceId: loomId(),
			});
			await db().insert(loomMigrationImports).values({ videoId, requestId });
			if (missing === "recording") {
				await db().delete(videos).where(eq(videos.id, videoId));
			} else {
				await db().delete(importedVideos).where(eq(importedVideos.id, videoId));
			}
			signInAs(operatorId);
			fixture.sendEmail.mockClear();
			await expect(
				actions.updateLoomMigrationStatus({
					requestId,
					nextStatus: "completed",
					message: "All done",
					verified: true,
					expectedVideoCount: 1,
					importedVideoCount: 1,
				}),
			).rejects.toThrow("missing or changed");
			const request = await getRequest(requestId);
			expect(request.status).not.toBe("completed");
			expect(request.activeOrganizationId).toBe(organizationId);
			expect(request.completedAt).toBeNull();
			expect(fixture.sendEmail).not.toHaveBeenCalled();
		},
	);

	it("reconciles only deleted inventory entries in the selected request", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);
		const other = await makeOrganization();
		const otherRequestId = await requestMigration(
			other.organizationId,
			other.ownerId,
		);
		const retainedVideoId = Video.VideoId.make(id());
		const deletedVideoId = Video.VideoId.make(id());
		const otherDeletedVideoId = Video.VideoId.make(id());
		await db().insert(videos).values({
			id: retainedVideoId,
			name: "Retained",
			ownerId,
			orgId: organizationId,
		});
		await db().insert(importedVideos).values({
			id: retainedVideoId,
			orgId: organizationId,
			source: "loom",
			sourceId: loomId(),
		});
		await db()
			.insert(loomMigrationImports)
			.values([
				{ videoId: retainedVideoId, requestId },
				{ videoId: deletedVideoId, requestId },
				{ videoId: otherDeletedVideoId, requestId: otherRequestId },
			]);
		signInAs(ownerId);
		await expect(
			actions.reconcileLoomMigrationInventory({ requestId, verified: true }),
		).rejects.toThrow();
		signInAs(operatorId);
		await expect(
			actions.reconcileLoomMigrationInventory({ requestId, verified: false }),
		).rejects.toThrow("source list first");
		fixture.sendEmail.mockClear();
		await expect(
			actions.reconcileLoomMigrationInventory({ requestId, verified: true }),
		).resolves.toEqual({ removedCount: 1, hasMore: false });
		expect(
			await db()
				.select({ videoId: loomMigrationImports.videoId })
				.from(loomMigrationImports)
				.where(eq(loomMigrationImports.requestId, requestId)),
		).toEqual([{ videoId: retainedVideoId }]);
		expect(
			await db()
				.select({ videoId: loomMigrationImports.videoId })
				.from(loomMigrationImports)
				.where(eq(loomMigrationImports.requestId, otherRequestId)),
		).toEqual([{ videoId: otherDeletedVideoId }]);
		expect(
			await db()
				.select({ id: videos.id })
				.from(videos)
				.where(eq(videos.id, retainedVideoId)),
		).toHaveLength(1);
		expect(
			await db()
				.select({ id: importedVideos.id })
				.from(importedVideos)
				.where(eq(importedVideos.id, retainedVideoId)),
		).toHaveLength(1);
		expect((await getRequest(requestId)).status).not.toBe("completed");
		expect(fixture.sendEmail).not.toHaveBeenCalled();
	});

	it("uploads restricted MP4 files to storage and starts processing", async () => {
		const { ownerId, organizationId } = await makeOrganization({
			privateByDefault: true,
		});
		const requestId = await requestMigration(organizationId, ownerId);
		const ownerEmail = `${id()}@example.com`;
		const loomUrl = `https://www.loom.com/share/${loomId()}`;

		signInAs(operatorId);
		await expect(
			loom.createConciergeLoomFileUpload({
				requestId,
				loomUrl: "http://evil.example.com/share/abcdefghijk",
				userEmail: ownerEmail,
				spaceName: "",
				videoTitle: "Kickoff",
			}),
		).rejects.toThrow("valid Loom video URL");

		const prepared = await loom.createConciergeLoomFileUpload({
			requestId,
			loomUrl,
			userEmail: ownerEmail,
			spaceName: "Imported",
			videoTitle: "Kickoff",
		});
		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, prepared.videoId));
		if (!video) throw new Error("Missing uploaded video");
		expect(video).toMatchObject({ orgId: organizationId, public: false });
		const [owner] = await db()
			.select({ email: users.email })
			.from(users)
			.where(eq(users.id, video.ownerId));
		expect(owner?.email).toBe(ownerEmail);
		const [imported] = await db()
			.select()
			.from(importedVideos)
			.where(eq(importedVideos.id, prepared.videoId));
		expect(imported?.source).toBe("loom");

		await expect(
			loom.finishConciergeLoomFileUpload({
				requestId,
				videoId: prepared.videoId,
			}),
		).rejects.toThrow("not found in storage");

		const retry = await loom.createConciergeLoomFileUpload({
			requestId,
			loomUrl,
			userEmail: ownerEmail,
			spaceName: "Imported",
			videoTitle: "Kickoff",
		});
		expect(retry.videoId).toBe(prepared.videoId);
		await expect(
			loom.createConciergeLoomFileUpload({
				requestId,
				loomUrl,
				userEmail: `${id()}@example.com`,
				spaceName: "",
				videoTitle: "Kickoff",
			}),
		).rejects.toThrow("already in the Cap import inventory");

		await uploadToTarget(retry.uploadTarget);

		fixture.start.mockClear();
		const finished = await loom.finishConciergeLoomFileUpload({
			requestId,
			videoId: prepared.videoId,
		});
		expect(finished.status).toBe("started");
		expect(fixture.start).toHaveBeenCalledTimes(1);
		const [upload] = await db()
			.select({ phase: videoUploads.phase })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, prepared.videoId));
		expect(upload?.phase).toBe("processing");
		expect((await getRequest(requestId)).queuedVideoCount).toBe(1);

		await expect(
			loom.createConciergeLoomFileUpload({
				requestId,
				loomUrl,
				userEmail: ownerEmail,
				spaceName: "",
				videoTitle: "Kickoff",
			}),
		).rejects.toThrow("already in the Cap import inventory");
	});

	it("recovers a failed automatic import with a restricted MP4", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);
		const ownerEmail = `${id()}@example.com`;
		const loomUrl = `https://www.loom.com/share/${loomId()}`;

		signInAs(operatorId);
		const imported = await loom.importFromLoomCsvForConcierge({
			requestId,
			rows: [{ rowNumber: 2, loomUrl, userEmail: ownerEmail, spaceName: "" }],
		});
		const videoId = imported.results[0]?.videoId;
		if (!videoId) throw new Error("Missing automatic import");
		await setUploadPhase(videoId, "error");
		const [failed] = await db()
			.select({ rawFileKey: videoUploads.rawFileKey })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
		expect(failed?.rawFileKey).toBeNull();

		const prepared = await loom.createConciergeLoomFileUpload({
			requestId,
			loomUrl,
			userEmail: ownerEmail,
			spaceName: "",
			videoTitle: "Recovered",
		});
		expect(prepared.videoId).toBe(videoId);
		const [video] = await db()
			.select({ ownerId: videos.ownerId })
			.from(videos)
			.where(eq(videos.id, videoId));
		const [recovering] = await db()
			.select({ rawFileKey: videoUploads.rawFileKey })
			.from(videoUploads)
			.where(eq(videoUploads.videoId, videoId));
		expect(recovering?.rawFileKey).toBe(
			`${video?.ownerId}/${videoId}/raw-upload.mp4`,
		);
		expect((await getRequest(requestId)).queuedVideoCount).toBe(1);

		await uploadToTarget(prepared.uploadTarget);
		fixture.start.mockClear();
		const finished = await loom.finishConciergeLoomFileUpload({
			requestId,
			videoId,
		});
		expect(finished.status).toBe("started");
		expect(fixture.start).toHaveBeenCalledTimes(1);
	});

	it("waits for an in-flight import transaction before completing", async () => {
		const { ownerId, organizationId } = await makeOrganization();
		const requestId = await requestMigration(organizationId, ownerId);
		if (!databaseUrl) throw new Error("Missing test database");
		const connection = await createConnection(databaseUrl);
		const videoId = id();
		try {
			await connection.beginTransaction();
			await connection.query(
				"SELECT id FROM loom_migration_requests WHERE id = ? FOR UPDATE",
				[requestId],
			);
			await connection.query(
				"INSERT INTO videos (id, ownerId, orgId, name, source, createdAt, updatedAt) VALUES (?, ?, ?, 'In flight', ?, NOW(), NOW())",
				[videoId, ownerId, organizationId, JSON.stringify({ type: "webMP4" })],
			);
			await connection.query(
				"INSERT INTO video_uploads (video_id, phase, mode) VALUES (?, 'uploading', 'singlepart')",
				[videoId],
			);
			await connection.query(
				"INSERT INTO loom_migration_imports (videoId, requestId, createdAt) VALUES (?, ?, NOW())",
				[videoId, requestId],
			);

			signInAs(operatorId);
			const completion = actions.updateLoomMigrationStatus({
				requestId,
				nextStatus: "completed",
				message: "",
				verified: true,
				expectedVideoCount: 0,
				importedVideoCount: 0,
			});
			const settled = completion.then(
				() => "completed",
				(error: Error) => error.message,
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			await connection.commit();

			expect(await settled).toContain("still processing");
			expect((await getRequest(requestId)).status).toBe("pending");
		} finally {
			await connection.end();
		}
	});

	it("refuses to map another request's video", async () => {
		const first = await makeOrganization();
		const firstRequest = await requestMigration(
			first.organizationId,
			first.ownerId,
		);
		const second = await makeOrganization();
		const secondRequest = await requestMigration(
			second.organizationId,
			second.ownerId,
		);

		signInAs(operatorId);
		const prepared = await loom.createConciergeLoomFileUpload({
			requestId: firstRequest,
			loomUrl: `https://www.loom.com/share/${loomId()}`,
			userEmail: `${id()}@example.com`,
			spaceName: "",
			videoTitle: "First",
		});
		await expect(
			loom.finishConciergeLoomFileUpload({
				requestId: secondRequest,
				videoId: prepared.videoId,
			}),
		).rejects.toThrow("no longer available");
	});
});
