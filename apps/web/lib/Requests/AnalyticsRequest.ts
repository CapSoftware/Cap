import { dataLoader } from "@effect/experimental/RequestResolver";
import type { Video } from "@inflight/web-domain";
import { Effect, Exit, Request, RequestResolver } from "effect";
import type { NonEmptyArray } from "effect/Array";
import { Rpc } from "@/lib/Rpcs";

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
