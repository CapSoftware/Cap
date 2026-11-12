import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/web-backend/src/S3Buckets/index", async () => {
	const { Effect, Layer, Option } = await import("effect");
	const HttpServerRequest = await import("@effect/platform/HttpServerRequest");
	const access = {
		getSignedObjectUrl: (key: string, args: { expiresIn: number }) =>
			Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
				Effect.map(
					(request) =>
						`signed:${key}:${args.expiresIn}:${Option.match(request, {
							onNone: () => "no-request",
							onSome: (value) => value.originalUrl,
						})}`,
				),
			),
	};
	return {
		S3Buckets: {
			Default: Layer.empty,
			getBucketAccess: () => Effect.succeed([access]),
		},
	};
});

const { requestAsSeenByViewer, signedDeveloperVideoUrl } = await import(
	"@/lib/developer-video-storage"
);

const playback = (headers: Record<string, string>) =>
	new Request("http://localhost:3000/api/developer/playback/id/video.mp4", {
		headers,
	});

describe("developer video storage signing", () => {
	it("signs with the address the viewer used, so a local storage endpoint can follow it", async () => {
		const url = await signedDeveloperVideoUrl(
			"developer/app/video/file.m4s",
			600,
			playback({ host: "192.168.1.20:3000" }),
		);

		expect(url).toBe(
			"signed:developer/app/video/file.m4s:600:http://192.168.1.20:3000/api/developer/playback/id/video.mp4",
		);
	});

	it("prefers the forwarded host and takes the first one", () => {
		expect(
			requestAsSeenByViewer(
				playback({
					host: "internal:3000",
					"x-forwarded-host": "media.example, proxy.internal",
				}),
			).url,
		).toBe("http://media.example/api/developer/playback/id/video.mp4");
	});

	it("keeps the request as it is without a usable host", () => {
		const bare = playback({});

		expect(requestAsSeenByViewer(bare)).toBe(bare);
		expect(requestAsSeenByViewer(playback({ host: "bad host" })).url).toBe(
			bare.url,
		);
	});
});
