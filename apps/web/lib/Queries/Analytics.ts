import type { Video } from "@cap/web-domain";
import { Effect } from "effect";
import { useEffectQuery } from "../EffectRuntime";
import { AnalyticsRequest } from "../Requests/AnalyticsRequest";

type AnalyticsDataLoader = Effect.Effect.Success<
	typeof AnalyticsRequest.DataLoaderResolver
>;

export function useVideosAnalyticsQuery(
	videoIds: Video.VideoId[],
	analyticsEnabled = true,
) {
	const uniqueVideoIds = Array.from(new Set<Video.VideoId>(videoIds));
	const queryKey = [
		"analytics",
		Boolean(analyticsEnabled),
		uniqueVideoIds.join("|"),
	] as const;

	const enabled = analyticsEnabled && uniqueVideoIds.length > 0;

	return useEffectQuery({
		queryKey,
		enabled,
		queryFn: () => {
			if (!analyticsEnabled || uniqueVideoIds.length === 0) {
				return Effect.succeed<Record<Video.VideoId, number>>({});
			}

			return Effect.flatMap(
				AnalyticsRequest.DataLoaderResolver,
				(dataloader: AnalyticsDataLoader) =>
					Effect.all(
						uniqueVideoIds.map((videoId) =>
							Effect.request(
								new AnalyticsRequest.AnalyticsRequest({ videoId }),
								dataloader,
							).pipe(
								Effect.catchAll((error: unknown) => {
									console.warn(
										`Failed to fetch analytics for video ${videoId}:`,
										error,
									);
									return Effect.succeed({ count: 0 });
								}),
								Effect.map((result: { count: number }) => ({
									videoId,
									count: result.count,
								})),
							),
						),
						{ concurrency: "unbounded" },
					).pipe(
						Effect.map((rows: Array<{ videoId: Video.VideoId; count: number }>) => {
							const output: Partial<Record<Video.VideoId, number>> = {};
							for (const row of rows) {
								output[row.videoId] = row.count;
							}
							return output as Record<Video.VideoId, number>;
						}),
					),
			);
		},
		refetchOnWindowFocus: false,
		refetchOnMount: true,
	});
}
