import { Exit, Layer } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockDbChain = {
	select: vi.fn(),
	from: vi.fn(),
	where: vi.fn(),
	limit: vi.fn(),
};

function resetDbChain() {
	for (const fn of Object.values(mockDbChain)) fn.mockClear();
	mockDbChain.select.mockReturnValue(mockDbChain);
	mockDbChain.from.mockReturnValue(mockDbChain);
	mockDbChain.where.mockReturnValue(mockDbChain);
	mockDbChain.limit.mockReturnValue(
		Promise.resolve([{ id: "video-1", transcriptionStatus: "COMPLETE" }]),
	);
}

vi.mock("@cap/database", () => ({ db: () => mockDbChain }));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "id" },
}));

const mockGetCurrentUser = vi.fn();
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => mockGetCurrentUser(),
}));

const mockCanView = vi.fn();
vi.mock("@cap/web-backend", () => ({
	makeCurrentUserLayer: () => Layer.empty,
	VideosPolicy: {
		key: "VideosPolicy",
	},
}));

// The route runs its query through the Effect runtime; the parts under test are
// which failures reach the handler and how it maps them, so the runtime is
// replaced with one that returns the exit the policy would have produced.
vi.mock("@/lib/server", () => ({
	runPromiseExit: () => mockCanView(),
}));

vi.mock("@cap/web-domain", async () => {
	const actual =
		await vi.importActual<typeof import("@cap/web-domain")>("@cap/web-domain");
	return {
		...actual,
		Policy: {
			...actual.Policy,
			withPublicPolicy: () => (self: unknown) => self,
		},
	};
});

const { GET } = await import("@/app/api/video/transcribe/status/route");
const { DatabaseError, Policy } = await import("@cap/web-domain");

const request = (videoId: string) =>
	new Request(
		`https://cap.test/api/video/transcribe/status?videoId=${videoId}`,
	) as never;

describe("GET /api/video/transcribe/status", () => {
	beforeEach(() => {
		resetDbChain();
		mockGetCurrentUser.mockResolvedValue({ id: "user-1" });
		mockCanView.mockReset();
	});

	it("returns 401 when there is no session", async () => {
		mockGetCurrentUser.mockResolvedValue(null);

		const res = await GET(request("video-1"));

		expect(res.status).toBe(401);
	});

	it("returns 400 when videoId is missing", async () => {
		const res = await GET(
			new Request("https://cap.test/api/video/transcribe/status") as never,
		);

		expect(res.status).toBe(400);
	});

	it("returns 404 when the access policy denies the caller", async () => {
		mockCanView.mockResolvedValue(
			Exit.fail(new Policy.PolicyDeniedError({ reason: "denied" })),
		);

		const res = await GET(request("video-1"));

		expect(res.status).toBe(404);
		await expect(res.json()).resolves.toMatchObject({
			message: "Video does not exist",
		});
	});

	it("returns 500, not 404, when the access check hits a database failure", async () => {
		mockCanView.mockResolvedValue(
			Exit.fail(new DatabaseError({ cause: new Error("connection reset") })),
		);

		const res = await GET(request("video-1"));

		expect(res.status).toBe(500);
		await expect(res.json()).resolves.toMatchObject({
			message: "Failed to fetch transcription status",
		});
	});

	it("returns the transcription status when access is granted", async () => {
		mockCanView.mockResolvedValue(
			Exit.succeed([{ id: "video-1", transcriptionStatus: "COMPLETE" }]),
		);

		const res = await GET(request("video-1"));

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toEqual({
			transcriptionStatus: "COMPLETE",
		});
	});

	it("returns 404 when the video row is missing", async () => {
		mockCanView.mockResolvedValue(Exit.succeed([]));

		const res = await GET(request("video-1"));

		expect(res.status).toBe(404);
	});
});
