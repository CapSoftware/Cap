import type { Video } from "@cap/web-domain";
import { dataLoader } from "@effect/experimental/RequestResolver";
import { Effect, Exit, Request, RequestResolver } from "effect";
import type { NonEmptyArray } from "effect/Array";
import { Rpc } from "@/lib/Rpcs";
import { useEffectQuery } from "../EffectRuntime";

export namespace AnalyticsRequest {
	export class AnalyticsRequest extends Request.Class<
		{ count: number },
		unknown,
		{ videoId: Video.VideoId }
	> {}

	export class DataLoaderResolver extends Effect.Service<DataLoaderResolver>()(
		"AnalyticsRequest/DataLoaderResolver",
		{
			scoped: Effect.gen(function* () {
				const rpc = yield* Rpc;

				const requestResolver = RequestResolver.makeBatched(
					(requests: NonEmptyArray<AnalyticsRequest>) =>
						rpc.VideosGetAnalytics(requests.map((r) => r.videoId)).pipe(
							Effect.flatMap(
								// biome-ignore lint/suspicious/useIterableCallbackReturn: effect
								Effect.forEach((result, index) =>
									Exit.matchEffect(result, {
										onSuccess: (v) => Request.succeed(requests[index]!, v),
										onFailure: (e) => Request.fail(requests[index]!, e),
									}),
								),
							),
							Effect.catchAll((error) =>
								Effect.forEach(
									requests,
									(request) => Request.fail(request, error),
									{
										discard: true,
									},
								),
							),
						),
				);

				return yield* dataLoader(requestResolver, {
					window: "10 millis",
				});
			}),
			dependencies: [Rpc.Default],
		},
	) {}
}

export function useVideosAnalyticsQuery(
	videoIds: Video.VideoId[],
	dubApiKeyEnabled?: boolean,
) {
	return useEffectQuery({
		queryKey: ["analytics", videoIds],
		queryFn: Effect.fn(function* () {
			if (!dubApiKeyEnabled) return {};

			const dataloader = yield* AnalyticsRequest.DataLoaderResolver;

			const results = yield* Effect.all(
				videoIds.map((videoId) =>
					Effect.request(
						new AnalyticsRequest.AnalyticsRequest({ videoId }),
						dataloader,
					).pipe(
						Effect.catchAll((e) => {
							console.warn(
								`Failed to fetch analytics for video ${videoId}:`,
								e,
							);
							return Effect.succeed({ count: 0 });
						}),
						Effect.map(({ count }) => ({ videoId, count })),
					),
				),
				{ concurrency: "unbounded" },
			);

			return results.reduce(
				(acc, current) => {
					acc[current.videoId] = current.count;
					return acc;
				},
				{} as Record<Video.VideoId, number>,
			);
		}),
		refetchOnWindowFocus: false,
		refetchOnMount: true,
	});
}
