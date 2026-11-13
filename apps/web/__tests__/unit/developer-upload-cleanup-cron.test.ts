import type { HttpApi } from "@effect/platform";
import { Effect, type Layer as EffectLayer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Upload = { Key?: string; UploadId?: string; Initiated?: Date };
type Page = {
	Uploads?: Upload[];
	IsTruncated?: boolean;
	NextKeyMarker?: string;
	NextUploadIdMarker?: string;
};

const mocks = vi.hoisted(() => ({
	pages: [] as Page[],
	failingAborts: new Set<string>(),
	listUploads: vi.fn(),
	abort: vi.fn(),
	purge: vi.fn(),
	purgeFailed: vi.fn(),
}));

vi.mock("@/lib/developer-video-purge", () => ({
	purgeDeletedDeveloperVideos: mocks.purge,
	purgeFailedDeveloperVideoFiles: mocks.purgeFailed,
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		S3Buckets: {
			getBucketAccess: () =>
				Effect.succeed([
					{
						multipart: {
							listUploads: mocks.listUploads,
							abort: mocks.abort,
						},
					},
				]),
		},
	};
});

type ApiLayer = EffectLayer.Layer<HttpApi.Api>;

vi.mock("@/lib/infra-video-upload", () => ({
	removeUnrecordedInfraFiles: async () => 3,
}));

vi.mock("@/lib/server", async () => {
	const { HttpApiBuilder, HttpServer } = await import("@effect/platform");
	const { Layer } = await import("effect");
	return {
		apiToHandler: (api: ApiLayer) => {
			const { handler } = HttpApiBuilder.toWebHandler(
				Layer.mergeAll(api, HttpServer.layerContext),
			);
			return (request: Request) => handler(request);
		},
	};
});

const NOW = new Date("2026-11-05T12:00:00.000Z");
const hoursAgo = (hours: number) =>
	new Date(NOW.getTime() - hours * 60 * 60 * 1000);

const cronRequest = (authorization?: string) =>
	new Request("https://localhost/api/cron/developer-upload-cleanup", {
		headers: authorization ? { authorization } : {},
	});

const runCron = async (authorization = "Bearer test-cron-secret") => {
	const { GET } = await import("@/app/api/cron/developer-upload-cleanup/route");
	return GET(cronRequest(authorization));
};

describe("developer upload cleanup cron", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.stubEnv("CRON_SECRET", "test-cron-secret");
		mocks.pages = [];
		mocks.failingAborts = new Set();
		mocks.listUploads.mockReset();
		mocks.listUploads.mockImplementation(() =>
			Effect.succeed(mocks.pages.shift() ?? { Uploads: [] }),
		);
		mocks.purge.mockReset();
		mocks.purge.mockResolvedValue({ purged: 0, failed: 0 });
		mocks.purgeFailed.mockReset();
		mocks.purgeFailed.mockResolvedValue({ purged: 0, failed: 0 });
		mocks.abort.mockReset();
		mocks.abort.mockImplementation((key: string, uploadId: string) =>
			mocks.failingAborts.has(uploadId)
				? Effect.fail(new Error(`abort failed for ${key}`))
				: Effect.succeed({}),
		);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
	});

	it("rejects requests without the cron secret", async () => {
		const response = await runCron("Bearer wrong-secret-value");

		expect(response.status).toBe(401);
		expect(mocks.listUploads).not.toHaveBeenCalled();
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("aborts developer uploads left incomplete for a day and keeps newer ones", async () => {
		mocks.pages = [
			{
				Uploads: [
					{
						Key: "developer/app-1/video-1/video",
						UploadId: "stale",
						Initiated: hoursAgo(30),
					},
					{
						Key: "developer/app-1/video-2/video",
						UploadId: "recent",
						Initiated: hoursAgo(2),
					},
					{
						Key: "developer/app-1/video-3/video",
						UploadId: "boundary",
						Initiated: hoursAgo(24),
					},
				],
			},
		];

		const response = await runCron();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			aborted: 2,
			failed: 0,
			moreToAbort: false,
			removed: 3,
			purged: 0,
			purgeFailed: 0,
		});
		expect(mocks.listUploads).toHaveBeenCalledWith({
			prefix: "developer/",
			keyMarker: undefined,
			uploadIdMarker: undefined,
		});
		expect(mocks.abort.mock.calls).toEqual([
			["developer/app-1/video-1/video", "stale"],
			["developer/app-1/video-3/video", "boundary"],
		]);
	});

	it("purges the files of deleted videos on every run", async () => {
		mocks.purge.mockResolvedValue({ purged: 3, failed: 0 });

		const response = await runCron();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ purged: 3, purgeFailed: 0 });
		expect(mocks.purge).toHaveBeenCalledTimes(1);
	});

	it("reports a failure when a deleted video's files could not be removed", async () => {
		mocks.purge.mockResolvedValue({ purged: 1, failed: 1 });

		const response = await runCron();

		expect(response.status).toBe(500);
	});

	it("removes the files of failed videos on every run and counts them with the purge", async () => {
		mocks.purge.mockResolvedValue({ purged: 3, failed: 0 });
		mocks.purgeFailed.mockResolvedValue({ purged: 2, failed: 0 });

		const response = await runCron();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ purged: 5, purgeFailed: 0 });
		expect(mocks.purgeFailed).toHaveBeenCalledTimes(1);
	});

	it("reports a failure when a failed video's files could not be removed", async () => {
		mocks.purgeFailed.mockResolvedValue({ purged: 1, failed: 1 });

		const response = await runCron();

		expect(response.status).toBe(500);
	});

	it("does not purge without the cron secret", async () => {
		await runCron("Bearer wrong-secret-value");

		expect(mocks.purge).not.toHaveBeenCalled();
		expect(mocks.purgeFailed).not.toHaveBeenCalled();
	});

	it("follows listing pages", async () => {
		mocks.pages = [
			{
				Uploads: [
					{
						Key: "developer/app-1/video-1/video",
						UploadId: "first",
						Initiated: hoursAgo(48),
					},
				],
				IsTruncated: true,
				NextKeyMarker: "developer/app-1/video-1/video",
				NextUploadIdMarker: "first",
			},
			{
				Uploads: [
					{
						Key: "developer/app-2/video-9/video",
						UploadId: "second",
						Initiated: hoursAgo(72),
					},
				],
			},
		];

		const response = await runCron();

		expect(await response.json()).toEqual({
			aborted: 2,
			failed: 0,
			moreToAbort: false,
			removed: 3,
			purged: 0,
			purgeFailed: 0,
		});
		expect(mocks.listUploads.mock.calls).toEqual([
			[
				{
					prefix: "developer/",
					keyMarker: undefined,
					uploadIdMarker: undefined,
				},
			],
			[
				{
					prefix: "developer/",
					keyMarker: "developer/app-1/video-1/video",
					uploadIdMarker: "first",
				},
			],
		]);
	});

	const stalePage = (
		count: number,
		from: number,
		truncated: boolean,
	): Page => ({
		Uploads: Array.from({ length: count }, (_, index) => ({
			Key: `developer/app-1/video-${from + index}/video`,
			UploadId: `upload-${from + index}`,
			Initiated: hoursAgo(48),
		})),
		IsTruncated: truncated,
		NextKeyMarker: `developer/app-1/video-${from + count - 1}/video`,
		NextUploadIdMarker: `upload-${from + count - 1}`,
	});

	it("aborts several uploads at a time", async () => {
		mocks.pages = [stalePage(100, 0, false)];
		let running = 0;
		let most = 0;
		mocks.abort.mockImplementation(() =>
			Effect.promise(async () => {
				running++;
				most = Math.max(most, running);
				await Promise.resolve();
				await Promise.resolve();
				running--;
				return {};
			}),
		);

		const response = await runCron();

		expect(await response.json()).toMatchObject({
			aborted: 100,
			moreToAbort: false,
		});
		expect(most).toBeGreaterThan(1);
		expect(most).toBeLessThanOrEqual(16);
	});

	it("stops at its budget and says there is more", async () => {
		mocks.pages = Array.from({ length: 7 }, (_, index) =>
			stalePage(1000, index * 1000, index < 6),
		);

		const response = await runCron();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			aborted: 5000,
			failed: 0,
			moreToAbort: true,
		});
		expect(mocks.abort).toHaveBeenCalledTimes(5000);
		expect(mocks.listUploads).toHaveBeenCalledTimes(5);
	});

	it("lets the aborts in flight finish once its time is up, starts no more and says there is more", async () => {
		mocks.pages = [stalePage(100, 0, true), stalePage(10, 100, true)];
		mocks.abort.mockImplementation(() =>
			Effect.sync(() => {
				vi.setSystemTime(new Date(Date.now() + 15_000));
				return {};
			}),
		);

		const response = await runCron();

		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			aborted: 16,
			failed: 0,
			moreToAbort: true,
		});
		expect(mocks.abort).toHaveBeenCalledTimes(16);
		expect(mocks.listUploads).toHaveBeenCalledTimes(1);
	});

	it("gives up on an abort that hangs and counts it as failed", async () => {
		vi.useRealTimers();
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		mocks.pages = [stalePage(2, 0, false)];
		mocks.abort.mockImplementation((_key: string, uploadId: string) =>
			uploadId === "upload-0" ? Effect.never : Effect.succeed({}),
		);

		const pending = runCron();
		await vi.advanceTimersByTimeAsync(11_000);
		const response = await pending;

		expect(response.status).toBe(500);
		expect(mocks.abort).toHaveBeenCalledTimes(2);
	});

	it("allows itself five minutes", async () => {
		const route = await import("@/app/api/cron/developer-upload-cleanup/route");

		expect(route.maxDuration).toBe(300);
	});

	it("keeps going when one abort fails and reports it", async () => {
		mocks.failingAborts = new Set(["broken"]);
		mocks.pages = [
			{
				Uploads: [
					{
						Key: "developer/app-1/video-1/video",
						UploadId: "broken",
						Initiated: hoursAgo(30),
					},
					{
						Key: "developer/app-1/video-2/video",
						UploadId: "fine",
						Initiated: hoursAgo(30),
					},
				],
			},
		];

		const response = await runCron();

		expect(response.status).toBe(500);
		expect(mocks.abort).toHaveBeenCalledTimes(2);
	});

	it("returns a server error when listing uploads fails", async () => {
		mocks.listUploads.mockImplementation(() =>
			Effect.fail(new Error("listing failed")),
		);

		const response = await runCron();

		expect(response.status).toBe(500);
		expect(mocks.abort).not.toHaveBeenCalled();
	});

	it("skips listing entries without a key, upload id or start time", async () => {
		mocks.pages = [
			{
				Uploads: [
					{ UploadId: "no-key", Initiated: hoursAgo(30) },
					{ Key: "developer/app-1/video-1/video", Initiated: hoursAgo(30) },
					{ Key: "developer/app-1/video-2/video", UploadId: "no-date" },
				],
			},
		];

		const response = await runCron();

		expect(await response.json()).toEqual({
			aborted: 0,
			failed: 0,
			moreToAbort: false,
			removed: 3,
			purged: 0,
			purgeFailed: 0,
		});
		expect(mocks.abort).not.toHaveBeenCalled();
	});
});
