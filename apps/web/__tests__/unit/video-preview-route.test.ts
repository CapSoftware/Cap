import { Effect } from "effect";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	source: {} as Record<string, string>,
	headObject: vi.fn(),
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect, Option } = await import("effect");
	return {
		provideOptionalAuth: <T>(effect: T) => effect,
		Videos: Effect.succeed({
			getByIdForViewing: () =>
				Effect.succeed(
					Option.some([
						{ id: "video", ownerId: "owner", source: mocks.source },
					]),
				),
		}),
		Storage: {
			getAccessForVideo: (video: { source: { previewKey?: string } }) =>
				Effect.succeed([
					{
						headObject: (key: string) => {
							const resolved =
								key === "owner/video/preview/animated-preview.gif"
									? (video.source.previewKey ?? key)
									: key;
							mocks.headObject(resolved);
							return Effect.succeed({ ContentLength: 1 });
						},
						getSignedObjectUrl: (key: string) =>
							Effect.succeed(
								`https://storage.test/${video.source.previewKey ?? key}`,
							),
					},
				]),
		},
	};
});
vi.mock("@cap/web-backend/src/Storage/index", () => ({ Storage: {} }));
vi.mock("@/lib/workflow-runtime", () => ({ runWorkflowPromise: vi.fn() }));
vi.mock("@/lib/server", () => ({ runPromise: Effect.runPromise }));

const { GET } = await import("@/app/api/video/preview/route");

const render =
	"owner/video/.recording/render/11111111-1111-4111-8111-111111111111/result";
const request = (fallback: string) =>
	new NextRequest(
		`https://cap.test/api/video/preview?videoId=video&fallback=${fallback}`,
	);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("video preview GIF route", () => {
	it("serves the upload's GIF while it is still the share video", async () => {
		mocks.source = { type: "webMP4" };

		const response = await GET(request("none"));

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"https://storage.test/owner/video/preview/animated-preview.gif",
		);
		expect(response.headers.get("cache-control")).toBe("private, max-age=60");
	});

	it("hides the upload's GIF once a render replaced the share video", async () => {
		mocks.source = { type: "webMP4", outputKey: `${render}.mp4` };

		const none = await GET(request("none"));
		expect(none.status).toBe(404);

		const og = await GET(request("og"));
		expect(og.status).toBe(302);
		expect(og.headers.get("location")).toBe(
			"https://cap.test/api/video/og?videoId=video",
		);
		expect(mocks.headObject).not.toHaveBeenCalled();
	});

	it("serves the GIF made from the render", async () => {
		mocks.source = {
			type: "webMP4",
			outputKey: `${render}.mp4`,
			previewKey: `${render}/preview.gif`,
		};

		const response = await GET(request("none"));

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			`https://storage.test/${render}/preview.gif`,
		);
	});
});
