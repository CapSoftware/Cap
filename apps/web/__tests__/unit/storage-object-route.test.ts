import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	verifyStorageObjectToken: vi.fn(),
}));

vi.mock("@cap/web-backend", () => ({
	provideOptionalAuth: {},
	Storage: {},
	Videos: {},
	VideosRepo: {},
	verifyStorageObjectToken: mocks.verifyStorageObjectToken,
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/utils/helpers", () => ({
	CACHE_CONTROL_HEADERS: {},
}));

describe("storage object route", () => {
	it.each([
		"owner-1/video-1/transcription.edit.v3.json",
		"owner-1/video-1/transcription.edit.v3.status.json",
	])("never proxies the private transcript object %s", async (key) => {
		const { GET } = await import("@/app/api/storage/object/route");
		const request = new NextRequest(
			`http://localhost:3000/api/storage/object?videoId=video-1&key=${encodeURIComponent(key)}&token=attacker-token`,
		);

		const response = await GET(request);

		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not found");
		expect(mocks.verifyStorageObjectToken).not.toHaveBeenCalled();
	});
});
