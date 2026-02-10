import type { Video } from "@cap/web-domain";
import { dataLoader } from "@effect/experimental/RequestResolver";
import { Effect, Request, RequestResolver } from "effect";
import type { NonEmptyArray } from "effect/Array";
import { Rpc } from "@/lib/Rpcs";

export namespace HoverPreviewRequest {
	export const queryKey = (videoId: string) =>
		["hoverPreview", videoId] as const;

	export class HoverPreviewRequest extends Request.Class<
		string | null,
		unknown,
		{ videoId: Video.VideoId }
	> {}

	export class DataLoaderResolver extends Effect.Service<DataLoaderResolver>()(
		"HoverPreviewRequest/DataLoaderResolver",
		{
			scoped: Effect.gen(function* () {
				const rpc = yield* Rpc;

				const requestResolver = RequestResolver.makeBatched(
					(requests: NonEmptyArray<HoverPreviewRequest>) =>
						rpc.VideosGetHoverPreviews(requests.map((r) => r.videoId)).pipe(
							Effect.flatMap((results) =>
								Effect.all(
									results.map((result, index) =>
										Effect.matchEffect(Effect.flatten(result), {
											onSuccess: (v) => Request.succeed(requests[index]!, v),
											onFailure: (e) => Request.fail(requests[index]!, e),
										}),
									),
									{ concurrency: "unbounded" },
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
