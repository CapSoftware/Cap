import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ gonePage: vi.fn() }));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => [] }) }),
	}),
}));
vi.mock("@cap/database/schema", () => ({ organizations: {} }));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_IS_CAP: "true" },
	serverEnv: () => ({
		WEB_URL: "https://cap.so",
		VERCEL_URL_HOST: undefined,
		VERCEL_BRANCH_URL_HOST: undefined,
		VERCEL_PROJECT_PRODUCTION_URL_HOST: undefined,
	}),
}));
vi.mock("@/lib/developer-video-takedown-store", () => ({
	developerVideoGonePage: mocks.gonePage,
}));

const { proxy } = await import("../../proxy");

const PLAYBACK_ID = "playback-id-0123456789ab";
const send = (path: string, method = "GET") =>
	proxy(new NextRequest(`https://cap.so${path}`, { method }));

beforeEach(() => {
	mocks.gonePage.mockReset();
	mocks.gonePage.mockResolvedValue(null);
});

describe("proxy takedown check", () => {
	it.each([`/dev/${PLAYBACK_ID}`, `/dev/${PLAYBACK_ID}/embed`])(
		"answers %s with the 410 page for a taken down video, with no cookies or frame headers",
		async (path) => {
			const gone = new Response("gone", {
				status: 410,
				headers: { "Cache-Control": "no-store" },
			});
			mocks.gonePage.mockResolvedValue(gone);

			const response = await send(`${path}?dub_id=click`);

			expect(response).toBe(gone);
			expect(mocks.gonePage).toHaveBeenCalledWith(path, "GET");
			expect(response.headers.get("set-cookie")).toBeNull();
			expect(response.headers.get("x-frame-options")).toBeNull();
		},
	);

	it("lets the page render when the video is not taken down", async () => {
		const response = await send(`/dev/${PLAYBACK_ID}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("x-middleware-next")).toBe("1");
	});

	it.each([
		`/s/${PLAYBACK_ID}`,
		`/s/${PLAYBACK_ID}/edit`,
		`/embed/${PLAYBACK_ID}`,
		"/c/collection",
		"/dashboard/caps",
		"/login",
		"/",
	])("never checks %s", async (path) => {
		const response = await send(path);

		expect(mocks.gonePage).not.toHaveBeenCalled();
		expect(response.status).not.toBe(410);
	});
});

describe("proxy takedown check on a self-hosted build", () => {
	it("skips the lookup, since only Cap staff can take a video down", async () => {
		vi.resetModules();
		vi.doMock("@cap/env", () => ({
			buildEnv: { NEXT_PUBLIC_IS_CAP: "false" },
			serverEnv: () => ({ WEB_URL: "https://cap.example.com" }),
		}));
		const selfHosted = await import("../../proxy");

		const response = await selfHosted.proxy(
			new NextRequest(`https://cap.example.com/dev/${PLAYBACK_ID}`),
		);

		expect(response.status).toBe(200);
		expect(mocks.gonePage).not.toHaveBeenCalled();
		vi.doUnmock("@cap/env");
	});
});
