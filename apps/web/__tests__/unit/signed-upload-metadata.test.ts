import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const updateWhere = vi.fn(async () => undefined);
	const updateSet = vi.fn(() => ({ where: updateWhere }));
	const db = {
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(async () => [
					{
						id: "video-1",
						ownerId: "user-1",
					},
				]),
			})),
		})),
		update: vi.fn(() => ({ set: updateSet })),
	};

	return { db, updateSet, updateWhere };
});

vi.mock("@cap/database", () => ({
	db: () => mocks.db,
	updateIfDefined: (value: unknown, column: unknown) => value ?? column,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => ({ id: "user-1" })),
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.test" },
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		Storage: {
			getAccessForVideo: vi.fn(() =>
				Effect.succeed([
					{
						createUploadTarget: vi.fn(() =>
							Effect.succeed({
								type: "put",
								url: "https://upload.test/object",
								headers: { "Content-Type": "video/mp4" },
							}),
						),
					},
				]),
			),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: (video: unknown) => video,
}));

import { app } from "@/app/api/upload/[...route]/signed";

function requestSignedUpload(metadata: Record<string, unknown> = {}) {
	return app.request("https://cap.test/", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			videoId: "video-1",
			subpath: "segments/video/init.mp4",
			method: "put",
			...metadata,
		}),
	});
}

describe("signed upload metadata", () => {
	beforeEach(() => {
		vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	it("does not update the video when metadata is omitted", async () => {
		const response = await requestSignedUpload();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			presignedPutData: {
				url: "https://upload.test/object",
				fields: {},
				headers: { "Content-Type": "video/mp4" },
				type: "put",
			},
		});
		expect(mocks.db.update).not.toHaveBeenCalled();
		expect(mocks.updateSet).not.toHaveBeenCalled();
		expect(mocks.updateWhere).not.toHaveBeenCalled();
	});

	it.each([
		["durationInSecs", 0],
		["width", 0],
		["height", 0],
		["fps", 0],
	])("updates the video when %s is supplied", async (field, value) => {
		const response = await requestSignedUpload({ [field]: value });

		expect(response.status).toBe(200);
		expect(mocks.db.update).toHaveBeenCalledTimes(1);
		expect(mocks.updateSet).toHaveBeenCalledTimes(1);
		expect(mocks.updateWhere).toHaveBeenCalledTimes(1);
	});
});
