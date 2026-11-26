import {
	Database,
	RpcAuthMiddlewareLive,
	VideoDownloadGate,
	Videos,
} from "@cap/web-backend";
import { VideosRpcsLive } from "@cap/web-backend/src/Videos/VideosRpcs";
import { DatabaseError, Video } from "@cap/web-domain";
import { HttpServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { type Context, Effect, Layer, Option } from "effect";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: null as { user: { id: string } } | null,
	access: vi.fn(),
	getDownloadInfo: vi.fn(),
	user: {
		id: "viewer",
		email: "viewer@example.com",
		activeOrganizationId: "organization",
		image: null,
	},
}));

vi.mock("server-only", () => ({}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ WEB_URL: "https://cap.so" }),
	buildEnv: {
		NEXT_PUBLIC_WEB_URL: "https://cap.so",
		NEXT_PUBLIC_IS_CAP: "true",
	},
}));
vi.mock("@cap/database", () => ({ db: () => ({}) }));
vi.mock("@cap/database/auth/auth-options", () => ({
	authOptions: () => ({}),
	getServerSession: async () => mocks.session,
}));

const database = Layer.succeed(
	Database,
	Database.make({
		use: (callback) =>
			Effect.tryPromise({
				try: () =>
					callback({
						select: () => ({
							from: () => ({ where: async () => [mocks.user] }),
						}),
					} as never),
				catch: (cause) => new DatabaseError({ cause }),
			}),
	}),
);

const videos = Layer.succeed(Videos, {
	getDownloadInfo: mocks.getDownloadInfo,
} as unknown as Context.Tag.Service<typeof Videos>);

const gate = Layer.succeed(VideoDownloadGate, { access: mocks.access });

const server = RpcServer.toWebHandler(Video.VideoRpcs, {
	layer: Layer.mergeAll(
		VideosRpcsLive.pipe(Layer.provide(Layer.mergeAll(videos, gate))),
		RpcAuthMiddlewareLive,
		RpcSerialization.layerJson,
		HttpServer.layerContext,
	).pipe(Layer.provide(database)),
});

afterAll(() => server.dispose());

const requestDownload = async () => {
	const response = await server.handler(
		new Request("https://cap.so/api/erpc", {
			method: "POST",
			headers: {
				host: "cap.so",
				"content-type": "application/json",
				"sec-fetch-site": "same-origin",
				origin: "https://cap.so",
			},
			body: JSON.stringify({
				_tag: "Request",
				id: "1",
				tag: "VideoGetDownloadInfo",
				payload: "video",
				headers: [],
			}),
		}),
	);
	const [message] = (await response.json()) as [
		{ exit: { _tag: string; value?: unknown; cause?: unknown } },
	];
	return message.exit;
};

beforeEach(() => {
	mocks.session = null;
	mocks.access.mockReset();
	mocks.getDownloadInfo.mockReset();
	mocks.getDownloadInfo.mockReturnValue(
		Effect.succeed(
			Option.some({
				fileName: "Recording.mp4",
				downloadUrl: "https://media.example.com/video.mp4",
			}),
		),
	);
});

describe("VideoGetDownloadInfo", () => {
	it("refuses a direct request the download check denies, without signing", async () => {
		mocks.access.mockReturnValue(Effect.succeed("denied"));
		const exit = await requestDownload();
		expect(exit._tag).toBe("Failure");
		expect(JSON.stringify(exit.cause)).toContain("PolicyDenied");
		expect(mocks.getDownloadInfo).not.toHaveBeenCalled();
	});

	it.each([
		["member", false],
		["viewer", true],
	] as const)(
		"signs for a %s, published video only: %s",
		async (access, publishedOnly) => {
			mocks.access.mockReturnValue(Effect.succeed(access));
			const exit = await requestDownload();
			expect(exit).toMatchObject({
				_tag: "Success",
				value: {
					_tag: "Some",
					value: { downloadUrl: "https://media.example.com/video.mp4" },
				},
			});
			expect(mocks.getDownloadInfo).toHaveBeenCalledWith("video", {
				publishedOnly,
			});
		},
	);

	it("passes no identity for a signed-out caller and the session user otherwise", async () => {
		mocks.access.mockReturnValue(Effect.succeed("viewer"));
		await requestDownload();
		expect(mocks.access.mock.calls[0]?.[0]).toBe("video");
		expect(Option.isNone(mocks.access.mock.calls[0]?.[1])).toBe(true);

		mocks.session = { user: { id: "viewer" } };
		await requestDownload();
		const viewer = mocks.access.mock.calls[1]?.[1] as Option.Option<{
			id: string;
		}>;
		expect(Option.isSome(viewer) && viewer.value.id).toBe("viewer");
	});
});
