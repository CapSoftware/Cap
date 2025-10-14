import type { Video } from "@cap/web-domain";
import { Effect } from "effect";
import { useEffectQuery } from "../EffectRuntime";
import { AnalyticsRequest } from "../Requests/AnalyticsRequest";

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
