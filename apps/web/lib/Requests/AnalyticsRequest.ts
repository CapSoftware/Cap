import type { Video } from "@cap/web-domain";
import { Context, Effect, Layer, Request, RequestResolver } from "effect";
import { Rpc } from "@/lib/Rpcs";

export namespace AnalyticsRequest {
	export class AnalyticsRequest extends Request.Class<
		{ videoId: Video.VideoId },
		{ count: number },
		unknown
	> {}

	export class DataLoaderResolver extends Context.Service<
		DataLoaderResolver,
		RequestResolver.RequestResolver<AnalyticsRequest>
	>()("AnalyticsRequest/DataLoaderResolver") {
		static readonly layer = Layer.effect(
			this,
			Effect.gen(function* () {
				const rpc = yield* Rpc;
				return RequestResolver.make<AnalyticsRequest>((entries) =>
					rpc
						.VideosGetAnalytics(entries.map((entry) => entry.request.videoId))
						.pipe(
							Effect.flatMap((results) =>
								Effect.forEach(
									entries,
									(entry, index) => {
										const result = results[index];
										return result
											? Request.complete(entry, result)
											: Request.fail(
													entry,
													new Error("Missing analytics result"),
												);
									},
									{ discard: true },
								),
							),
							Effect.catch((error) =>
								Effect.forEach(entries, (entry) => Request.fail(entry, error), {
									discard: true,
								}),
							),
						),
				).pipe(RequestResolver.setDelayEffect(Effect.sleep("10 millis")));
			}),
		);
		static readonly Default = this.layer.pipe(Layer.provide(Rpc.Default));
	}
}
