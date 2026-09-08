import type { Video } from "@cap/web-domain";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RetryableError } from "workflow";

const { db, start, where, syncVideoDisplayNames, runWorkflowPromise } =
	vi.hoisted(() => ({
		db: vi.fn(),
		start: vi.fn(),
		where: vi.fn(),
		syncVideoDisplayNames: vi.fn(),
		runWorkflowPromise: vi.fn(() => Promise.resolve()),
	}));

vi.mock("@cap/database", () => ({ db }));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", storageIntegrationId: "storageIntegrationId" },
}));
vi.mock("@cap/web-backend/src/Storage/index", () => ({
	Storage: { syncVideoDisplayNames },
}));
vi.mock("drizzle-orm", () => ({
	eq: (...args: unknown[]) => args,
}));
vi.mock("workflow/api", () => ({ start }));
vi.mock("@/lib/workflow-runtime", () => ({
	runWorkflowPromise,
}));

const { enqueueVideoStorageNameSync } = await import(
	"@/lib/sync-video-storage-names"
);
const { syncVideoStorageNamesWorkflow } = await import(
	"@/workflows/sync-video-storage-names"
);

const configureVideoLookup = (storageIntegrationId: string | null) => {
	where.mockResolvedValue([{ storageIntegrationId }]);
	db.mockReturnValue({
		select: vi.fn(() => ({
			from: vi.fn(() => ({ where })),
		})),
	});
};

describe("video storage display name queue", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not start a workflow for S3 or missing videos", async () => {
		configureVideoLookup(null);
		await enqueueVideoStorageNameSync("video-s3" as Video.VideoId);
		expect(start).not.toHaveBeenCalled();

		where.mockResolvedValue([]);
		await enqueueVideoStorageNameSync("video-missing" as Video.VideoId);
		expect(start).not.toHaveBeenCalled();
	});

	it("starts the workflow only for videos with a stored integration", async () => {
		configureVideoLookup("drive-integration");

		await enqueueVideoStorageNameSync("video-drive" as Video.VideoId);

		expect(start).toHaveBeenCalledWith(syncVideoStorageNamesWorkflow, [
			{ videoId: "video-drive" },
		]);
	});

	it("swallows lookup and dispatch errors after a committed title update", async () => {
		const error = new Error("workflow unavailable");
		where.mockRejectedValue(error);
		db.mockReturnValue({
			select: vi.fn(() => ({
				from: vi.fn(() => ({ where })),
			})),
		});
		const log = vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			enqueueVideoStorageNameSync("video-error" as Video.VideoId),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalled();

		configureVideoLookup("drive-integration");
		start.mockRejectedValue(error);
		await expect(
			enqueueVideoStorageNameSync("video-dispatch-error" as Video.VideoId),
		).resolves.toBeUndefined();
		expect(log).toHaveBeenCalledTimes(2);
		log.mockRestore();
	});
});

describe("video storage display name workflow", () => {
	it("spaces retries so an upload can finish before names are synchronized", async () => {
		syncVideoDisplayNames.mockReturnValue({
			pipe: vi.fn((runner: (effect: unknown) => unknown) => runner({})),
		});
		runWorkflowPromise.mockRejectedValueOnce(new Error("Upload pending"));
		vi.spyOn(console, "error").mockImplementation(() => {});

		await expect(
			syncVideoStorageNamesWorkflow({ videoId: "video-pending" }),
		).rejects.toBeInstanceOf(RetryableError);
	});

	it("calls the storage synchronizer in a retriable step", async () => {
		const pipe = vi.fn((runner: (effect: unknown) => unknown) => runner({}));
		syncVideoDisplayNames.mockReturnValue({ pipe });

		await syncVideoStorageNamesWorkflow({ videoId: "video-drive" });

		expect(syncVideoDisplayNames).toHaveBeenCalledWith("video-drive");
		expect(pipe).toHaveBeenCalled();
	});
});
