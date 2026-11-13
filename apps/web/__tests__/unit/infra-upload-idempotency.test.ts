import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
	videos: new Map<string, Record<string, unknown>>(),
	inserts: 0,
	nextId: 0,
	admission: vi.fn(),
}));

vi.mock("@cap/database", async () => {
	const { drizzle } = await import("drizzle-orm/mysql-proxy");
	const columnsOf = (list: string) =>
		[...list.matchAll(/`([A-Za-z0-9]+)`(?:,|\))/g)].map(
			(match) => match[1] ?? "",
		);
	const client = drizzle(async (sql, params) => {
		if (sql.startsWith("insert into `developer_videos`")) {
			const columns = columnsOf(
				sql.slice(sql.indexOf("("), sql.indexOf(")") + 1),
			);
			const values = sql
				.slice(sql.indexOf("values (") + 8, sql.lastIndexOf(")"))
				.split(", ");
			const row: Row = {};
			let param = 0;
			columns.forEach((column, index) => {
				row[column] = values[index] === "?" ? params[param++] : null;
			});
			const id = String(row.id);
			if (state.videos.has(id)) {
				if (!sql.includes("on duplicate key update")) {
					throw new Error("Duplicate entry for key PRIMARY");
				}
				return { rows: [{ affectedRows: 0 }] };
			}
			state.inserts += 1;
			state.videos.set(id, {
				...row,
				metadata:
					typeof row.metadata === "string"
						? JSON.parse(row.metadata)
						: row.metadata,
				duration: null,
				deletedAt: null,
				status: "uploading",
			});
			return { rows: [{ affectedRows: 1 }] };
		}
		if (sql.includes("from `developer_videos`")) {
			const fields = sql
				.slice("select ".length, sql.indexOf(" from "))
				.split(", ")
				.map((field) => field.replaceAll("`", "").split(".").pop() ?? "");
			const video = state.videos.get(String(params[0]));
			if (!video) return { rows: [] };
			return {
				rows: [fields.map((field) => video[field] ?? null)],
			};
		}
		throw new Error(`Unexpected query: ${sql}`);
	});
	return { db: () => client };
});
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `random-video-${++state.nextId}`,
	nanoIdLength: 15,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.test" },
	serverEnv: () => ({ WEB_URL: "https://cap.test" }),
}));
vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: <T>(effect: T) => effect,
	S3Buckets: {},
}));
vi.mock("@/lib/server", () => ({ runPromise: async () => undefined }));
vi.mock("@/lib/infra-standing", async (original) => ({
	...(await original<typeof import("@/lib/infra-standing")>()),
	getInfraUploadAdmission: state.admission,
}));
vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: vi.fn(),
	releaseDeveloperVideoUpload: vi.fn(),
	startDeveloperVideoProcessing: vi.fn(),
	redriveDeveloperVideoProcessing: vi.fn(),
}));

import { developerVideoIdForIdempotencyKey } from "@/lib/developer-ids";
import { createInfraVideo } from "@/lib/infra-video-upload";

const admitted = {
	allowed: true,
	reason: null,
	standing: { state: "active", pausesAt: null },
	balanceMicroCredits: 1_000_000,
	requiredMicroCredits: 1,
	shortfallMicroCredits: 0,
	message: null,
};

const KEY = "retry-upload-0001";
const request = {
	appId: "app-1",
	name: "Standup",
	userId: "user_42",
	metadata: { project: "alpha", tags: ["a", "b"] },
	maxResolutionTier: "1440p" as const,
	idempotencyKey: KEY,
};

beforeEach(() => {
	state.videos = new Map();
	state.inserts = 0;
	state.nextId = 0;
	state.admission.mockReset();
	state.admission.mockResolvedValue(admitted);
});

describe("create upload with an Idempotency-Key", () => {
	it("returns the same video for a repeated request and makes one row", async () => {
		const first = await createInfraVideo(request);
		const second = await createInfraVideo({
			...request,
			metadata: { tags: ["a", "b"], project: "alpha" },
		});

		expect(first.status).toBe(200);
		expect(second).toEqual(first);
		expect(first.status === 200 && first.body.videoId).toBe(
			developerVideoIdForIdempotencyKey("app-1", KEY),
		);
		expect(state.inserts).toBe(1);
		expect(state.videos.size).toBe(1);
	});

	it("never stores Cap's takedown marker from a client's metadata, and replays the request", async () => {
		const withMarker = {
			...request,
			metadata: {
				project: "alpha",
				tags: ["a", "b"],
				__capTakedown: { at: "2026-11-13T12:00:00.000Z", metadata: null },
			},
		};
		const first = await createInfraVideo(withMarker);
		const id = developerVideoIdForIdempotencyKey("app-1", KEY);

		expect(first.status).toBe(200);
		expect(state.videos.get(id)?.metadata).toEqual({
			project: "alpha",
			tags: ["a", "b"],
		});
		expect(await createInfraVideo(withMarker)).toEqual(first);
		expect(state.inserts).toBe(1);
	});

	it("makes one video when the same request races itself", async () => {
		const results = await Promise.all(
			Array.from({ length: 5 }, () => createInfraVideo(request)),
		);

		expect(new Set(results.map((result) => result.status))).toEqual(
			new Set([200]),
		);
		expect(
			new Set(results.map((result) => JSON.stringify(result.body))).size,
		).toBe(1);
		expect(state.videos.size).toBe(1);
	});

	it.each([
		["name", { name: "Retro" }],
		["userId", { userId: "user_43" }],
		["maxResolutionTier", { maxResolutionTier: "2160p" as const }],
		["metadata", { metadata: { project: "beta" } }],
	])("refuses the same key with a different %s", async (field, change) => {
		await createInfraVideo(request);

		const conflict = await createInfraVideo({ ...request, ...change });

		expect(conflict).toMatchObject({
			status: 409,
			body: {
				code: "idempotency_conflict",
				message: `Idempotency key was already used with a different ${field}`,
			},
		});
		expect(state.videos.size).toBe(1);
	});

	it("refuses a key whose video was deleted and answers a completed upload like a token renewal", async () => {
		await createInfraVideo(request);
		const id = developerVideoIdForIdempotencyKey("app-1", KEY);
		const stored = state.videos.get(id);
		if (!stored) throw new Error("video missing");

		stored.duration = 12;
		expect(await createInfraVideo(request)).toMatchObject({
			status: 409,
			body: { code: "upload_already_completed" },
		});

		stored.deletedAt = "2026-11-13 10:00:00";
		expect(await createInfraVideo(request)).toMatchObject({
			status: 409,
			body: {
				code: "idempotency_conflict",
				message: "Idempotency key belongs to a video that was deleted",
			},
		});
		expect(state.videos.size).toBe(1);
	});

	it("checks upload admission on a repeat too", async () => {
		await createInfraVideo(request);
		state.admission.mockResolvedValueOnce({
			...admitted,
			allowed: false,
			reason: "insufficient_credits",
			message: "Add credit",
		});

		expect(await createInfraVideo(request)).toMatchObject({ status: 402 });
		expect(state.admission).toHaveBeenCalledTimes(2);
		expect(state.videos.size).toBe(1);
	});

	it("keeps the same key separate per app, and creates a new video each time without a key", async () => {
		await createInfraVideo(request);
		await createInfraVideo({ ...request, appId: "app-2" });
		await createInfraVideo({ ...request, idempotencyKey: undefined });
		await createInfraVideo({ ...request, idempotencyKey: undefined });

		expect(state.videos.size).toBe(4);
	});
});
