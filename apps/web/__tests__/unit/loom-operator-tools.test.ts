import type { HttpApi } from "@effect/platform";
import type { SQL } from "drizzle-orm";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { Effect, type Layer as EffectLayer, Option } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	selects: [] as unknown[][],
	affectedRows: 1,
	updates: [] as Array<Record<string, unknown>>,
	deletes: 0,
	pro: true,
	process: vi.fn(),
	objects: [] as Array<{ Key: string; Size: number }>,
	copies: [] as Array<[string, string]>,
	removed: [] as string[][],
	headSize: undefined as number | undefined,
	destinationObjects: [] as Array<{ Key: string; Size: number }>,
	puts: [] as Array<[string, string]>,
	stored: new Map<string, string>(),
	deleteFails: false,
	claims: [] as Array<Record<string, unknown>>,
	claimRows: 1,
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => {
	const selection = {
		from: () => selection,
		innerJoin: () => selection,
		leftJoin: () => selection,
		where: () => selection,
		limit: async () => mocks.selects.shift() ?? [],
	};
	const tx = {
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: async () => {
					mocks.updates.push(values);
					return [{ affectedRows: mocks.affectedRows }];
				},
			}),
		}),
		delete: () => ({
			where: async () => {
				mocks.deletes++;
			},
		}),
	};
	return {
		db: () => ({
			select: () => selection,
			update: () => ({
				set: (values: Record<string, unknown>) => ({
					where: async () => {
						mocks.claims.push(values);
						return [{ affectedRows: mocks.claimRows }];
					},
				}),
			}),
			transaction: async (run: (handle: typeof tx) => Promise<unknown>) =>
				run(tx),
		}),
	};
});
vi.mock("@cap/database/schema", () => ({
	importedVideos: { id: "i.id", orgId: "i.orgId", source: "i.source" },
	organizationMembers: { organizationId: "m.org", userId: "m.user" },
	organizations: { id: "o.id", ownerId: "o.owner", tombstoneAt: "o.tomb" },
	sharedVideos: { videoId: "s.video" },
	spaceVideos: { videoId: "sv.video" },
	videos: {
		id: "v.id",
		ownerId: "v.owner",
		orgId: "v.org",
		bucket: "v.bucket",
		storageIntegrationId: "v.integration",
	},
	videoUploads: { videoId: "u.video", phase: "u.phase" },
}));
vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: () =>
			Effect.succeed([
				{
					bucketName: "capso",
					listObjects: ({ prefix }: { prefix: string }) =>
						Effect.succeed({
							Contents: prefix.startsWith(ids.from)
								? mocks.objects
								: mocks.destinationObjects,
							IsTruncated: false,
						}),
					getObject: (key: string) =>
						Effect.succeed(Option.fromNullable(mocks.stored.get(key))),
					putObject: (key: string, body: string) => {
						mocks.puts.push([key, body]);
						return Effect.void;
					},
					copyObjectForRecording: (source: string, destination: string) => {
						mocks.copies.push([source, destination]);
						return Effect.succeed({});
					},
					headObject: (key: string) =>
						Effect.succeed({
							ContentLength:
								mocks.headSize ??
								mocks.objects.find((object) =>
									key.endsWith(object.Key.split("/").slice(2).join("/")),
								)?.Size,
						}),
					deleteObjects: (keys: Array<{ Key: string }>) => {
						if (mocks.deleteFails) return Effect.fail(new Error("denied"));
						mocks.removed.push(keys.map(({ Key }) => Key));
						return Effect.succeed({});
					},
				},
			]),
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		MEDIA_SERVER_WEBHOOK_SECRET: "media-secret",
		NEXTAUTH_SECRET: "test-secret",
	}),
}));
vi.mock("@/lib/loom-csv-import", () => ({
	processLoomCsvRows: mocks.process,
}));
vi.mock("@/lib/org-pro", () => ({
	isOrganizationOwnerPro: async () => mocks.pro,
}));

type ApiLayer = EffectLayer.Layer<HttpApi.Api>;

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Effect, Layer } = await import("effect");
	return {
		runPromise: (effect: Effect.Effect<unknown>) => Effect.runPromise(effect),
		apiToHandler: (api: ApiLayer) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

import { POST as importCsv } from "@/app/api/internal/loom-imports/csv/route";
import { POST as reassign } from "@/app/api/internal/loom-imports/reassign/route";
import { getEditTranscriptObjectKey } from "@/lib/edit-transcript";
import {
	decryptEditTranscriptObject,
	encryptEditTranscriptObject,
} from "@/lib/edit-transcript-storage";
import { reassignLoomImport } from "@/lib/loom-import-reassign";
import { getOwnerOriginalKey } from "@/lib/loom-original-key";

const call = (
	handler: (request: Request) => Promise<Response>,
	path: string,
	body: unknown,
	secret: string | null = "media-secret",
) =>
	handler(
		new NextRequest(`https://cap.so/api/internal/loom-imports/${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(secret ? { "x-media-server-secret": secret } : {}),
			},
			body: JSON.stringify(body),
		}),
	);

const ids = {
	org: "orgaaaaaaaaaaaa",
	from: "fromaaaaaaaaaaa",
	to: "toaaaaaaaaaaaaa",
	video: "videoaaaaaaaaaa",
};
const importedVideo = (overrides: Record<string, unknown> = {}) => ({
	ownerId: ids.from,
	orgId: ids.org,
	bucketId: null,
	storageIntegrationId: null,
	uploadPhase: null,
	...overrides,
});

beforeEach(() => {
	mocks.selects = [];
	mocks.affectedRows = 1;
	mocks.updates = [];
	mocks.deletes = 0;
	mocks.pro = true;
	mocks.process.mockReset().mockResolvedValue({
		success: true,
		importedCount: 1,
		failedCount: 0,
		results: [
			{ rowNumber: 2, userEmail: "a@b.co", success: true, videoId: "v1" },
		],
	});
	mocks.objects = [
		{ Key: `${ids.from}/${ids.video}/result.mp4`, Size: 100 },
		{ Key: `${ids.from}/${ids.video}/screenshot/screen-capture.jpg`, Size: 5 },
	];
	mocks.copies = [];
	mocks.removed = [];
	mocks.headSize = undefined;
	mocks.destinationObjects = [];
	mocks.puts = [];
	mocks.stored = new Map();
	mocks.deleteFails = false;
	mocks.claims = [];
	mocks.claimRows = 1;
});

describe("operator CSV import", () => {
	const body = {
		organizationId: ids.org,
		rows: [
			{
				rowNumber: 2,
				loomUrl: "https://www.loom.com/share/abc",
				userEmail: "a@b.co",
			},
		],
	};

	it("requires the media server secret", async () => {
		expect((await call(importCsv, "csv", body, null)).status).toBe(401);
		expect((await call(importCsv, "csv", body, "wrong")).status).toBe(401);
		expect(mocks.process).not.toHaveBeenCalled();
	});

	it("imports rows as the workspace owner", async () => {
		mocks.selects = [[{ ownerId: "owneraaaaaaaaaa" }]];
		const response = await call(importCsv, "csv", body);
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ importedCount: 1 });
		expect(mocks.process).toHaveBeenCalledWith({
			rows: [{ ...body.rows[0], spaceName: "" }],
			orgId: ids.org,
			actorId: "owneraaaaaaaaaa",
			allowFolders: true,
			importPriority: "bulk",
		});
	});

	it("refuses missing workspaces and workspaces without Pro", async () => {
		expect((await call(importCsv, "csv", body)).status).toBe(404);
		mocks.selects = [[{ ownerId: "owneraaaaaaaaaa" }]];
		mocks.pro = false;
		expect((await call(importCsv, "csv", body)).status).toBe(403);
		expect(mocks.process).not.toHaveBeenCalled();
	});

	it("rejects batches over 25 rows", async () => {
		const rows = Array.from({ length: 26 }, (_, index) => ({
			...body.rows[0],
			rowNumber: index + 2,
		}));
		expect(
			(await call(importCsv, "csv", { organizationId: ids.org, rows })).status,
		).toBe(400);
	});
});

describe("reassignLoomImport", () => {
	const input = {
		organizationId: ids.org,
		videoId: ids.video,
		fromUserId: ids.from,
		toUserId: ids.to,
	};

	it("copies every object, switches owner privately, then removes the old copies", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await expect(reassignLoomImport(input)).resolves.toEqual({
			videoId: ids.video,
			status: "moved",
			copiedObjects: 2,
			cleanup: "done",
		});
		expect(mocks.copies).toEqual([
			[
				`capso/${ids.from}/${ids.video}/result.mp4`,
				`${ids.to}/${ids.video}/result.mp4`,
			],
			[
				`capso/${ids.from}/${ids.video}/screenshot/screen-capture.jpg`,
				`${ids.to}/${ids.video}/screenshot/screen-capture.jpg`,
			],
		]);
		expect(mocks.updates).toEqual([
			expect.objectContaining({
				ownerId: ids.to,
				public: false,
				folderId: null,
			}),
		]);
		expect(mocks.deletes).toBe(2);
		expect(mocks.removed).toEqual([mocks.objects.map(({ Key }) => Key)]);
	});

	it.each([
		[[], "not a Loom import here"],
		[[importedVideo({ orgId: "otheraaaaaaaaaa" })], "not a Loom import here"],
		[[importedVideo({ ownerId: ids.to })], "already owned"],
		[[importedVideo({ ownerId: "someoneaaaaaaaa" })], "different owner"],
		[[importedVideo({ bucketId: "bucket" })], "custom storage"],
		[[importedVideo({ uploadPhase: "processing" })], "import not finished"],
		[
			[importedVideo({ source: { type: "webMP4", outputKey: "edited.mp4" } })],
			"edited video",
		],
		[
			[
				importedVideo({
					metadata: {
						loomDeferredProcessing: {
							status: "started",
							rawFileKey: `${ids.from}/${ids.video}/raw-upload.webm`,
						},
					},
				}),
			],
			"conversion running",
		],
		[[importedVideo(), []], "new owner not a member"],
	])("leaves unsafe moves alone: %#", async (selects, reason) => {
		mocks.selects = (selects as unknown[]).map((row) =>
			Array.isArray(row) ? row : [row],
		);
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "skipped",
			reason,
		});
		expect(mocks.copies).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});

	it("does not touch a video another move has claimed", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		mocks.claimRows = 0;
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "skipped",
			reason: "another move is running",
		});
		expect(mocks.copies).toEqual([]);
		expect(mocks.removed).toEqual([]);
	});

	it("releases its claim after a failed move", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		mocks.headSize = 1;
		await expect(reassignLoomImport(input)).rejects.toThrow();
		expect(mocks.claims).toHaveLength(2);
	});

	it("points a pending conversion at the new owner's copy", async () => {
		mocks.selects = [
			[
				importedVideo({
					metadata: {
						loomDeferredProcessing: {
							status: "pending",
							rawFileKey: `someoneaaaaaaaa/${ids.video}/raw-upload.webm`,
						},
					},
				}),
			],
			[{ userId: ids.to }],
		];
		await reassignLoomImport(input);
		const query = new MySqlDialect().sqlToQuery(
			mocks.updates[0]?.metadata as SQL,
		);
		expect(query.sql).toContain("'$.loomDeferredProcessing.rawFileKey', ?)");
		expect(query.params).toEqual([`${ids.to}/${ids.video}/raw-upload.webm`]);
	});

	it("leaves metadata alone for videos without a pending conversion", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await reassignLoomImport(input);
		expect(mocks.updates[0]).not.toHaveProperty("metadata");
	});

	it("keeps sharing and visibility when asked", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await expect(
			reassignLoomImport({
				...input,
				options: { keepSharing: true, folderId: "folderaaaaaaaaa" },
			}),
		).resolves.toMatchObject({ status: "moved" });
		expect(mocks.updates).toEqual([
			expect.objectContaining({ ownerId: ids.to, folderId: "folderaaaaaaaaa" }),
		]);
		expect(mocks.updates[0]).not.toHaveProperty("public");
		expect(mocks.deletes).toBe(0);
	});

	it("re-encrypts the word transcript for the new owner", async () => {
		const key = getEditTranscriptObjectKey(ids.from, ids.video);
		mocks.objects.push({ Key: key, Size: 50 });
		mocks.stored.set(
			key,
			encryptEditTranscriptObject("hello world", ids.from, ids.video),
		);
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "moved",
			copiedObjects: 3,
		});
		const [destinationKey, body] = mocks.puts[0] ?? [];
		expect(destinationKey).toBe(getEditTranscriptObjectKey(ids.to, ids.video));
		expect(decryptEditTranscriptObject(body ?? "", ids.to, ids.video)).toBe(
			"hello world",
		);
		expect(mocks.copies.map(([source]) => source)).not.toContain(
			`capso/${key}`,
		);
	});

	it("does not copy over files the new owner already has", async () => {
		mocks.destinationObjects = [
			{ Key: `${ids.to}/${ids.video}/result.mp4`, Size: 100 },
		];
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "skipped",
		});
		expect(mocks.copies).toEqual([]);
		expect(mocks.updates).toEqual([]);
	});

	it("reports old files it could not remove", async () => {
		mocks.deleteFails = true;
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "moved",
			cleanup: "failed",
		});
	});

	it("keeps the original when a copy does not match", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		mocks.headSize = 1;
		await expect(reassignLoomImport(input)).rejects.toThrow("size mismatch");
		expect(mocks.updates).toEqual([]);
		expect(mocks.removed).toEqual([
			[
				`${ids.to}/${ids.video}/result.mp4`,
				`${ids.to}/${ids.video}/screenshot/screen-capture.jpg`,
			],
		]);
	});

	it("keeps the original files and removes its copies when the claim was lost", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		mocks.affectedRows = 0;
		await expect(reassignLoomImport(input)).resolves.toMatchObject({
			status: "failed",
		});
		expect(mocks.removed).toEqual([
			[
				`${ids.to}/${ids.video}/result.mp4`,
				`${ids.to}/${ids.video}/screenshot/screen-capture.jpg`,
			],
		]);
	});
});

describe("POST /api/internal/loom-imports/reassign", () => {
	const body = {
		organizationId: ids.org,
		fromUserId: ids.from,
		toUserId: ids.to,
		videoIds: [ids.video],
	};

	it("requires the media server secret", async () => {
		expect((await call(reassign, "reassign", body, null)).status).toBe(401);
		expect(mocks.copies).toEqual([]);
	});

	it("reports each video once", async () => {
		mocks.selects = [[importedVideo()], [{ userId: ids.to }]];
		const response = await call(reassign, "reassign", {
			...body,
			videoIds: [ids.video, ids.video],
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			results: [
				{
					videoId: ids.video,
					status: "moved",
					copiedObjects: 2,
					cleanup: "done",
				},
			],
		});
	});
});

describe("getOwnerOriginalKey", () => {
	it.each([
		["a/vid/raw-upload.webm", "b/vid/raw-upload.webm"],
		["a/vid/nested/file.webm", "b/vid/nested/file.webm"],
		["a/other/raw-upload.webm", null],
		["a/vid/", null],
		[undefined, null],
	])("%s -> %s", (key, expected) => {
		expect(getOwnerOriginalKey(key, "b", "vid")).toBe(expected);
	});
});
