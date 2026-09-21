import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	where: vi.fn(),
	set: vi.fn(),
	queue: vi.fn(),
	start: vi.fn(),
	getRun: vi.fn(),
	getWorld: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({ update: () => ({ set: mocks.set }) }),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "videoId", ownerId: "ownerId", metadata: "metadata" },
	videoUploads: {
		videoId: "uploadVideoId",
		phase: "phase",
		updatedAt: "updatedAt",
	},
}));
vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (id: string) => id } },
	User: { UserId: { make: (id: string) => id } },
}));
vi.mock("drizzle-orm", () => ({
	eq: (column: string, value: unknown) => ({ column, value }),
	and: (...conditions: unknown[]) => ({ conditions }),
	sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
		strings,
		values,
	}),
}));
vi.mock("workflow/api", () => ({ start: mocks.start, getRun: mocks.getRun }));
vi.mock("workflow/runtime", () => ({ getWorld: mocks.getWorld }));
vi.mock("@/workflows/import-loom-video", () => ({
	importLoomVideoWorkflow: vi.fn(),
}));

import {
	isLoomImportRunning,
	LoomImportStartError,
	restoreLoomImportStartError,
	startLoomImportWorkflow,
} from "@/lib/loom-import-start";

const payload = {
	videoId: "video-1",
	userId: "owner-1",
	rawFileKey: "owner-1/video-1/raw-upload.mp4",
	bucketId: null,
	loomVideoId: "loom-1",
};

describe("Loom workflow startup receipts", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		mocks.set.mockReturnValue({ where: mocks.where });
		mocks.where.mockResolvedValue([{ affectedRows: 1 }]);
		mocks.queue.mockResolvedValue({ messageId: "message-1" });
		mocks.getWorld.mockReturnValue({ queue: mocks.queue });
		mocks.start.mockImplementation(
			async (
				_workflow: unknown,
				_args: unknown,
				options: {
					world: {
						queue: (
							name: string,
							message: { runId: string },
						) => Promise<unknown>;
					};
				},
			) => {
				await options.world.queue("workflow-loom", { runId: "run-1" });
			},
		);
	});

	it("records the run before dispatch and stores queue acceptance", async () => {
		await startLoomImportWorkflow(payload);
		expect(
			mocks.set.mock.calls.map(([value]) =>
				JSON.parse(value.metadata.values[1]),
			),
		).toEqual([
			{ runId: "run-1", dispatch: "pending" },
			{ runId: "run-1", dispatch: "accepted" },
		]);
		expect(mocks.where.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.queue.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it.each([
		"BadRequestError",
		"UnauthorizedError",
		"ForbiddenError",
		"TooManyRequestsError",
	])("allows retry after an explicit queue rejection: %s", async (name) => {
		mocks.queue.mockRejectedValueOnce(
			Object.assign(new Error("Queue rejected"), { name }),
		);
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: true,
		});
		expect(
			JSON.parse(mocks.set.mock.calls.at(-1)?.[0].metadata.values[1]),
		).toEqual({ runId: "run-1", dispatch: "rejected" });
	});

	it("preserves an uncertain queue acknowledgement without allowing another dispatch", async () => {
		mocks.queue.mockRejectedValueOnce(new TypeError("Connection reset"));
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: false,
		});
		expect(
			JSON.parse(mocks.set.mock.calls.at(-1)?.[0].metadata.values[1]),
		).toEqual({ runId: "run-1", dispatch: "uncertain" });
	});

	it("does not treat a run creation error as a rejected queue message", async () => {
		mocks.start.mockImplementationOnce(
			async (
				_workflow: unknown,
				_args: unknown,
				options: {
					world: {
						queue: (
							name: string,
							message: { runId: string },
						) => Promise<unknown>;
					};
				},
			) => {
				await options.world.queue("workflow-loom", { runId: "run-1" });
				throw Object.assign(new Error("Run creation rejected"), {
					name: "BadRequestError",
				});
			},
		);
		await expect(startLoomImportWorkflow(payload)).resolves.toBeUndefined();
		expect(
			JSON.parse(mocks.set.mock.calls.at(-1)?.[0].metadata.values[1]).dispatch,
		).toBe("accepted");
	});

	it("allows retry when startup fails before dispatch", async () => {
		mocks.start.mockRejectedValueOnce(new Error("Workflow not registered"));
		await expect(startLoomImportWorkflow(payload)).rejects.toBeInstanceOf(
			LoomImportStartError,
		);
		await expect(startLoomImportWorkflow(payload)).resolves.toBeUndefined();
		expect(mocks.queue).toHaveBeenCalledTimes(1);
	});

	it("does not send a job when its run receipt cannot be saved", async () => {
		mocks.where.mockResolvedValueOnce([{ affectedRows: 0 }]);
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: true,
		});
		expect(mocks.queue).not.toHaveBeenCalled();
	});

	it("keeps the claim when a rejected dispatch receipt cannot be saved", async () => {
		mocks.queue.mockRejectedValueOnce(
			Object.assign(new Error("Queue rejected"), { name: "ForbiddenError" }),
		);
		mocks.where
			.mockResolvedValueOnce([{ affectedRows: 1 }])
			.mockRejectedValueOnce(new Error("Database unavailable"));
		await expect(startLoomImportWorkflow(payload)).rejects.toMatchObject({
			canRetry: false,
		});
	});

	it.each(["pending", "running", "completed", "failed", "cancelled"] as const)(
		"uses authoritative run status for %s",
		async (status) => {
			mocks.getRun.mockReturnValue({ status: Promise.resolve(status) });
			expect(
				await isLoomImportRunning({ runId: "run-1", dispatch: "uncertain" }),
			).toBe(status === "pending" || status === "running");
		},
	);

	it("holds startup while the run cannot be queried", async () => {
		mocks.getRun.mockReturnValue({
			status: Promise.reject(new Error("Not found yet")),
		});
		expect(
			await isLoomImportRunning({ runId: "run-1", dispatch: "uncertain" }),
		).toBe(true);
	});

	it("allows rejected and legacy imports without an active run check", async () => {
		expect(
			await isLoomImportRunning({ runId: "run-1", dispatch: "rejected" }),
		).toBe(false);
		expect(await isLoomImportRunning()).toBe(false);
		expect(mocks.getRun).not.toHaveBeenCalled();
	});

	it("only restores the same upload claim after dispatch rejection", async () => {
		const claimedAt = new Date("2026-09-01T00:00:00Z");
		await restoreLoomImportStartError(
			"video-1",
			"processing",
			claimedAt,
			"Startup rejected",
		);
		expect(mocks.set).toHaveBeenCalledWith(
			expect.objectContaining({
				phase: "error",
				processingError: "Startup rejected",
			}),
		);
		expect(mocks.where).toHaveBeenCalledWith({
			conditions: [
				{ column: "uploadVideoId", value: "video-1" },
				{ column: "phase", value: "processing" },
				{ column: "updatedAt", value: claimedAt },
			],
		});
	});
});
