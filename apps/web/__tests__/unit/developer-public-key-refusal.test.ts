import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = await vi.hoisted(() => import("./developer-upload-harness"));

vi.mock("@cap/database", () => harness.databaseMock());
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `video-${++harness.state.nextVideo}`,
	nanoIdLength: 15,
}));
vi.mock("@cap/database/auth/session", () => ({ getCurrentUser: vi.fn() }));
vi.mock("@cap/database/auth/domain-utils", () => ({
	isBlockedAccountEmail: () => false,
}));
vi.mock("@cap/database/auth/request-site", () => ({
	isCrossSiteCookieWrite: () => false,
}));
vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: harness.ORIGIN },
	serverEnv: () => ({
		WEB_URL: harness.ORIGIN,
		NEXTAUTH_SECRET: "unit-test-signing-secret",
	}),
}));
vi.mock("@cap/web-backend", () => harness.storageMock());
vi.mock("@/lib/server", () => harness.serverMock());
vi.mock("@/lib/developer-key-hash", () => ({
	hashKey: async (key: string) => `hash:${key}`,
}));
vi.mock("@/lib/infra-standing", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/infra-standing")>()),
	getInfraUploadAdmission: harness.state.admission,
}));
vi.mock("@/lib/developer-video-start", () => ({
	claimDeveloperVideoUpload: harness.state.claim,
	releaseDeveloperVideoUpload: harness.state.release,
	startDeveloperVideoProcessing: harness.state.startProcessing,
	redriveDeveloperVideoProcessing: vi.fn(),
}));

const sdk = await import("@/app/api/developer/sdk/v1/[...route]/route");

const { state, post, videoWrites, storageCalls, UPLOAD_ROUTES } = harness;

const PUBLIC_KEY = "cpk_app1_copied_from_a_page";
const FORGED_ORIGIN = { Origin: "https://customer.example" };

beforeEach(() => {
	harness.resetUploadHarness();
	state.videos.set("video-1", {
		appId: "app1",
		duration: null,
		deletedAt: null,
		status: "uploading",
	});
});

describe("a public key copied from a customer's page", () => {
	it.each([
		["a production app and a forged Origin", "production", FORGED_ORIGIN],
		["a development app and no Origin", "development", {}],
	] as const)(
		"cannot create a video for %s",
		async (_label, environment, headers) => {
			state.environment = environment;

			const response = await post(
				sdk,
				"/api/developer/sdk/v1/videos/create",
				PUBLIC_KEY,
				{ name: "Not the customer's video" },
				headers,
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "public_key_not_allowed",
				hint: expect.stringContaining("/api/developer/v1/uploads"),
			});
			expect(videoWrites()).toHaveLength(0);
			expect(state.admission).not.toHaveBeenCalled();
		},
	);

	it.each(UPLOAD_ROUTES)(
		"cannot call upload %s, and storage is never asked",
		async (route, body) => {
			const response = await post(
				sdk,
				`/api/developer/sdk/v1/upload/multipart/${route}`,
				PUBLIC_KEY,
				{ videoId: "video-1", ...body },
				FORGED_ORIGIN,
			);

			expect(response.status).toBe(403);
			expect(await response.json()).toMatchObject({
				code: "public_key_not_allowed",
				hint: expect.stringContaining("/api/developer/v1/uploads"),
			});
			expect(storageCalls()).toBe(0);
			expect(videoWrites()).toHaveLength(0);
			expect(state.claim).not.toHaveBeenCalled();
			expect(state.startProcessing).not.toHaveBeenCalled();
		},
	);

	it("is refused before any key lookup", async () => {
		await post(
			sdk,
			"/api/developer/sdk/v1/upload/multipart/initiate",
			PUBLIC_KEY,
			{ videoId: "video-1" },
			FORGED_ORIGIN,
		);

		expect(state.query).not.toHaveBeenCalled();
	});
});
