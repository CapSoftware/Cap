import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	emitAppStoreEvent: vi.fn(async () => 0),
	pending: [] as unknown[],
	inRequest: { value: true },
}));

vi.mock("@/lib/app-store/events", () => ({
	emitAppStoreEvent: mocks.emitAppStoreEvent,
}));

vi.mock("next/server", () => ({
	after: (task: unknown) => {
		if (!mocks.inRequest.value) throw new Error("outside a request scope");
		mocks.pending.push(task);
	},
}));

import { announceAppStoreEvent } from "@/lib/app-store/announce";

const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("announceAppStoreEvent", () => {
	beforeEach(() => {
		mocks.pending.length = 0;
		mocks.emitAppStoreEvent.mockClear();
		mocks.inRequest.value = true;
	});

	it("waits for the response before it looks up installations", async () => {
		announceAppStoreEvent("cap.comment.created", "video-1" as never, {
			commentId: "comment-1",
		});
		await flush();

		expect(mocks.emitAppStoreEvent).not.toHaveBeenCalled();
		expect(mocks.pending).toHaveLength(1);
		expect(typeof mocks.pending[0]).toBe("function");

		await (mocks.pending[0] as () => Promise<void>)();
		expect(mocks.emitAppStoreEvent).toHaveBeenCalledWith(
			"cap.comment.created",
			"video-1",
			{ commentId: "comment-1" },
		);
	});

	it("emits straight away outside a request scope", async () => {
		mocks.inRequest.value = false;
		announceAppStoreEvent("cap.ready", "video-2" as never);
		await flush();

		expect(mocks.emitAppStoreEvent).toHaveBeenCalledTimes(1);
		expect(mocks.emitAppStoreEvent).toHaveBeenCalledWith(
			"cap.ready",
			"video-2",
			{},
		);
	});

	it("never throws when the emitter fails", async () => {
		mocks.inRequest.value = false;
		mocks.emitAppStoreEvent.mockRejectedValueOnce(new Error("db down"));
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(() =>
			announceAppStoreEvent("cap.ready", "video-3" as never),
		).not.toThrow();
		await flush();
		expect(errors).toHaveBeenCalled();
		errors.mockRestore();
	});
});
