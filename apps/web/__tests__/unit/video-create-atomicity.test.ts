import { Organisation, User, Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type CreateVideoInput,
	VideosRepo,
} from "../../../../packages/web-backend/src/Videos/VideosRepo";

type Row = Record<string, unknown>;
type Store = {
	videos: Map<string, Row>;
	uploads: Map<string, Row>;
};

const mocks = vi.hoisted(() => ({
	store: {
		videos: new Map<string, Row>(),
		uploads: new Map<string, Row>(),
	} as Store,
	rejectUpload: false,
	transactionCalls: 0,
	currentUser: vi.fn(),
	organizationAccess: vi.fn(),
	createUploadTargetForUser: vi.fn(),
	createUploadTargetForVideo: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/database", () => {
	type Table = { name: "video" | "upload" };
	type Client = {
		insert: (table: Table) => { values: (row: Row | Row[]) => Promise<void> };
		select: () => {
			from: (table: Table) => { where: () => Promise<Row[]> };
		};
		transaction: (run: (tx: Client) => Promise<unknown>) => Promise<unknown>;
	};

	function makeClient(store: Store): Client {
		return {
			insert: (table) => ({
				values: async (value) => {
					if (table.name === "upload" && mocks.rejectUpload)
						throw new Error("Injected upload insert failure");
					const rows = table.name === "video" ? store.videos : store.uploads;
					for (const row of Array.isArray(value) ? value : [value]) {
						const key = String(table.name === "video" ? row.id : row.videoId);
						rows.set(key, { ...row });
					}
				},
			}),
			select: () => ({
				from: (table) => ({
					where: async () =>
						table.name === "video" ? [...store.videos.values()] : [],
				}),
			}),
			transaction: async (run) => {
				mocks.transactionCalls += 1;
				const candidate = {
					videos: new Map(store.videos),
					uploads: new Map(store.uploads),
				};
				const result = await run(makeClient(candidate));
				mocks.store = candidate;
				return result;
			},
		};
	}

	return { db: () => makeClient(mocks.store) };
});

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.currentUser,
}));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "fixture-video" }));
vi.mock("@cap/database/schema", () => ({
	videos: { name: "video", id: "id" },
	videoUploads: { name: "upload", videoId: "videoId" },
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ CAP_VIDEOS_DEFAULT_PUBLIC: true }),
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => true }));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		createUploadTargetForUser: mocks.createUploadTargetForUser,
		createUploadTargetForVideo: mocks.createUploadTargetForVideo,
	},
}));
vi.mock("@/actions/organization/authorization", () => ({
	requireOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("@/lib/server", async () => ({
	runPromise: (await import("effect")).Effect.runPromise,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("drizzle-orm", () => ({
	eq: (_field: unknown, value: unknown) => value,
}));

import { createVideoForServerProcessing } from "@/actions/video/create-for-processing";
import { createVideoAndGetUploadUrl } from "@/actions/video/upload";

const orgId = Organisation.OrganisationId.make("fixture-org");
const uploadTarget = {
	type: "s3Post" as const,
	url: "https://uploads.example.com/fixture",
	fields: {},
};
const repoCreateData: CreateVideoInput = {
	ownerId: User.UserId.make("fixture-user"),
	orgId,
	name: "Fixture recording",
	public: true,
	source: { type: "webMP4" },
	bucketId: Option.none(),
	storageIntegrationId: Option.none(),
	folderId: Option.none(),
	metadata: Option.none(),
	transcriptionStatus: Option.none(),
	width: Option.none(),
	height: Option.none(),
	duration: Option.none(),
};

function createRepoVideo(initialUpload?: {
	mode: "singlepart";
	total?: number;
}) {
	return Effect.runPromise(
		Effect.flatMap(VideosRepo, (repo) =>
			repo.create(repoCreateData, {
				id: Video.VideoId.make("fixture-video"),
				initialUpload,
			}),
		).pipe(Effect.provide(VideosRepo.Default)),
	);
}

beforeEach(() => {
	mocks.store = { videos: new Map(), uploads: new Map() };
	mocks.rejectUpload = false;
	mocks.transactionCalls = 0;
	mocks.currentUser.mockResolvedValue({ id: "fixture-user" });
	mocks.organizationAccess.mockResolvedValue(undefined);
	mocks.createUploadTargetForUser.mockReturnValue(
		Effect.succeed({
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			upload: uploadTarget,
		}),
	);
	mocks.createUploadTargetForVideo.mockReturnValue(
		Effect.succeed(uploadTarget),
	);
	vi.spyOn(console, "error").mockImplementation(() => undefined);
});

function expectCommittedPair() {
	expect(mocks.transactionCalls).toBe(1);
	expect(mocks.store.videos.size).toBe(1);
	expect(mocks.store.uploads.size).toBe(1);
	const video = [...mocks.store.videos.values()][0];
	const upload = [...mocks.store.uploads.values()][0];
	expect(upload?.videoId).toBe(video?.id);
	expect(mocks.revalidatePath.mock.calls.map(([path]) => path)).toEqual([
		"/dashboard/caps",
		"/dashboard/folder",
		"/dashboard/spaces",
	]);
}

describe("video creation with upload progress", () => {
	it("does not sign or change a recording owned by another user", async () => {
		const videoId = Video.VideoId.make("fixture-video");
		const existingVideo = { id: videoId, ownerId: "other-fixture-user" };
		mocks.store.videos.set(videoId, existingVideo);
		await expect(
			createVideoAndGetUploadUrl({
				orgId,
				videoId,
				supportsUploadProgress: true,
			}),
		).rejects.toThrow("Forbidden");
		expect(mocks.store.videos.get(videoId)).toEqual(existingVideo);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.transactionCalls).toBe(0);
		expect(mocks.createUploadTargetForVideo).not.toHaveBeenCalled();
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("rolls back a recording when the progress insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(
			createVideoAndGetUploadUrl({ orgId, supportsUploadProgress: true }),
		).rejects.toThrow("Injected upload insert failure");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("commits a recording and its progress row together", async () => {
		const result = await createVideoAndGetUploadUrl({
			orgId,
			supportsUploadProgress: true,
		});
		expect(result.id).toBe("fixture-video");
		expectCommittedPair();
	});

	it("creates only a recording when progress is disabled", async () => {
		const result = await createVideoAndGetUploadUrl({ orgId });
		expect(result.id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(1);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).toHaveBeenCalledTimes(3);
	});
});

describe("video creation for server processing", () => {
	it("rolls back a video when the progress insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(createVideoForServerProcessing({ orgId })).rejects.toThrow(
			"Injected upload insert failure",
		);
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("commits the video and its raw upload metadata together", async () => {
		const result = await createVideoForServerProcessing({ orgId });
		expect(result.id).toBe("fixture-video");
		expectCommittedPair();
		const upload = [...mocks.store.uploads.values()][0];
		expect(upload).toMatchObject({
			mode: "singlepart",
			phase: "uploading",
			processingProgress: 0,
			rawFileKey: "fixture-user/fixture-video/raw-upload.mp4",
		});
	});
});

describe("VideosRepo.create", () => {
	it("commits a video and optional upload row together", async () => {
		const id = await createRepoVideo({ mode: "singlepart", total: 123 });
		expect(id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.get(id)).toMatchObject({
			id,
			ownerId: "fixture-user",
			orgId,
		});
		expect(mocks.store.uploads.get(id)).toMatchObject({
			videoId: id,
			mode: "singlepart",
			total: 123,
		});
		expect(mocks.revalidatePath).not.toHaveBeenCalled();
	});

	it("rolls back a video if its optional upload insert fails", async () => {
		mocks.rejectUpload = true;
		await expect(createRepoVideo({ mode: "singlepart" })).rejects.toThrow(
			"Injected upload insert failure",
		);
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.size).toBe(0);
		expect(mocks.store.uploads.size).toBe(0);
	});

	it("commits a video without an upload row when progress is disabled", async () => {
		const id = await createRepoVideo();
		expect(id).toBe("fixture-video");
		expect(mocks.transactionCalls).toBe(1);
		expect(mocks.store.videos.get(id)?.id).toBe(id);
		expect(mocks.store.uploads.size).toBe(0);
	});
});
