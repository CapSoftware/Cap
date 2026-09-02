import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	head: vi.fn(),
	read: vi.fn(),
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	return {
		provideOptionalAuth: (effect: unknown) => effect,
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{ headObject: mocks.head, getObjectResponse: mocks.read },
				]),
		},
		Videos: {},
		VideosRepo: Effect.succeed({
			getById: () =>
				Effect.succeed(Option.some([{ id: "video", ownerId: "owner" }])),
		}),
		verifyStorageObjectToken: () => ({
			videoId: "video",
			key: "owner/video/result.mp4",
		}),
	};
});
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});
vi.mock("@/utils/helpers", () => ({ CACHE_CONTROL_HEADERS: {} }));

import { GET } from "@/app/api/storage/object/route";

function request(headers: Record<string, string> = {}) {
	return GET(
		new NextRequest(
			"https://cap.test/api/storage/object?videoId=video&key=owner/video/result.mp4&token=test",
			{ headers },
		),
	);
}

describe("recording verification object reads", () => {
	beforeEach(() => {
		mocks.head.mockReturnValue(
			Effect.succeed({ ETag: '"drive-file:42"', ContentLength: 100 }),
		);
		mocks.read.mockImplementation(() =>
			Effect.succeed(
				new Response("data", {
					status: 206,
					headers: { "Content-Range": "bytes 0-3/100" },
				}),
			),
		);
	});

	it("does not add metadata requests to ordinary playback", async () => {
		const response = await request();
		expect(response.status).toBe(206);
		expect(mocks.head).not.toHaveBeenCalled();
	});

	it("returns the provider version with a verification read", async () => {
		const response = await request({
			"X-Cap-Recording-Verification": "1",
			Range: "bytes=0-3",
		});
		expect(response.headers.get("ETag")).toBe('"drive-file:42"');
		expect(await response.text()).toBe("data");
		expect(mocks.read).toHaveBeenCalledWith(
			"owner/video/result.mp4",
			"bytes=0-3",
		);
	});

	it("refuses a replaced object before streaming its bytes", async () => {
		const response = await request({
			"X-Cap-Recording-Verification": "1",
			"If-Match": '"drive-file:41"',
		});
		expect(response.status).toBe(412);
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("refuses verification when no stable provider version exists", async () => {
		mocks.head.mockReturnValue(Effect.succeed({ ContentLength: 100 }));
		const response = await request({ "X-Cap-Recording-Verification": "1" });
		expect(response.status).toBe(503);
		expect(mocks.read).not.toHaveBeenCalled();
	});
});
