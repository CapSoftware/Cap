import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/web-backend/src/S3Buckets/index", async () => {
	const { Effect, Layer, Option } = await import("effect");
	const HttpServerRequest = await import("@effect/platform/HttpServerRequest");
	const access = {
		getSignedObjectUrl: (
			key: string,
			args: { signingDate: Date; expiresIn: number },
		) =>
			Effect.serviceOption(HttpServerRequest.HttpServerRequest).pipe(
				Effect.map(
					(request) =>
						`signed:${key}:${args.signingDate.toISOString()}+${args.expiresIn}:${Option.match(
							request,
							{
								onNone: () => "no-request",
								onSome: (value) => value.originalUrl,
							},
						)}`,
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

const {
	developerVideoUrlAnswersAnyOrigin,
	requestAsSeenByViewer,
	signedDeveloperVideoUrl,
} = await import("@/lib/developer-video-storage");

const playback = (headers: Record<string, string>) =>
	new Request("http://localhost:3000/api/developer/playback/id/video.mp4", {
		headers,
	});

describe("developer video storage signing", () => {
	it("signs with the address the viewer used, so a local storage endpoint can follow it", async () => {
		const url = await signedDeveloperVideoUrl(
			"developer/app/video/file.m4s",
			{ signingDate: new Date("2026-11-12T12:00:00.000Z"), expiresIn: 600 },
			playback({ host: "192.168.1.20:3000" }),
		);

		expect(url).toBe(
			"signed:developer/app/video/file.m4s:2026-11-12T12:00:00.000Z+600:http://192.168.1.20:3000/api/developer/playback/id/video.mp4",
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

	it("lets a player reach media through a redirect only when the CDN serves it", () => {
		expect(
			developerVideoUrlAnswersAnyOrigin(
				"https://cdn.example/developer/app/video/file.m4s?Policy=p&Key-Pair-Id=K1&Signature=s",
			),
		).toBe(true);
		expect(
			developerVideoUrlAnswersAnyOrigin(
				"http://localhost:9000/capso/developer/app/video/file.m4s?X-Amz-Signature=s",
			),
		).toBe(false);
	});
});
