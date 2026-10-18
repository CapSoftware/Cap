import { Video } from "@cap/web-domain";
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";
import { AnalyticsRequest } from "@/lib/Requests/AnalyticsRequest";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { Rpc } from "@/lib/Rpcs";

const ids = ["first", "second", "third"].map((id) => Video.VideoId.make(id));

const makeLayer = (
	analytics: (videoIds: ReadonlyArray<Video.VideoId>) => Effect.Effect<unknown>,
	thumbnails: (
		videoIds: ReadonlyArray<Video.VideoId>,
	) => Effect.Effect<unknown>,
) =>
	Layer.mergeAll(
		AnalyticsRequest.DataLoaderResolver.layer,
		ThumbnailRequest.DataLoaderResolver.layer,
	).pipe(
		Layer.provide(
			Layer.succeed(Rpc, {
				VideosGetAnalytics: analytics,
				VideosGetThumbnails: thumbnails,
			} as unknown as Rpc["Service"]),
		),
	);

describe("Effect request resolvers", () => {
	it("batches concurrent analytics requests", async () => {
		const analytics = vi.fn((videoIds: ReadonlyArray<Video.VideoId>) =>
			Effect.succeed(
				videoIds.map((_, index) => Exit.succeed({ count: index + 1 })),
			),
		);
		const layer = makeLayer(analytics, () => Effect.succeed([]));
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* AnalyticsRequest.DataLoaderResolver;
				return yield* Effect.all(
					ids.map((videoId) =>
						Effect.request(
							new AnalyticsRequest.AnalyticsRequest({ videoId }),
							resolver,
						),
					),
					{ concurrency: "unbounded" },
				);
			}).pipe(Effect.provide(layer)),
		);

		expect(analytics).toHaveBeenCalledTimes(1);
		expect(analytics).toHaveBeenCalledWith(ids);
		expect(results).toEqual([{ count: 1 }, { count: 2 }, { count: 3 }]);
	});

	it("maps thumbnail absence and per-item failures", async () => {
		const thumbnails = vi.fn(() =>
			Effect.succeed([
				Exit.succeed(Option.some("https://example.com/thumbnail.png")),
				Exit.succeed(Option.none()),
				Exit.fail(new Error("Thumbnail unavailable")),
			]),
		);
		const layer = makeLayer(() => Effect.succeed([]), thumbnails);
		const results = await Effect.runPromise(
			Effect.gen(function* () {
				const resolver = yield* ThumbnailRequest.DataLoaderResolver;
				return yield* Effect.all(
					ids.map((videoId) =>
						Effect.exit(
							Effect.request(
								new ThumbnailRequest.ThumbnailRequest({ videoId }),
								resolver,
							),
						),
					),
					{ concurrency: "unbounded" },
				);
			}).pipe(Effect.provide(layer)),
		);

		expect(thumbnails).toHaveBeenCalledTimes(1);
		expect(results[0]).toMatchObject({
			_tag: "Success",
			value: "https://example.com/thumbnail.png",
		});
		expect(results[1]).toMatchObject({ _tag: "Success", value: null });
		expect(results[2] && Exit.isFailure(results[2])).toBe(true);
	});
});
