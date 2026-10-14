import type { Video } from "@cap/web-domain";
import {
	Context,
	Effect,
	Exit,
	Layer,
	Option,
	Request,
	RequestResolver,
} from "effect";
import { Rpc } from "@/lib/Rpcs";

export namespace ThumbnailRequest {
	export const queryKey = (videoId: string) => ["thumbnail", videoId] as const;

	export class ThumbnailRequest extends Request.Class<
		{ videoId: Video.VideoId },
		string | null,
		unknown
	> {}

	export class DataLoaderResolver extends Context.Service<
		DataLoaderResolver,
		RequestResolver.RequestResolver<ThumbnailRequest>
	>()("ThumbnailRequest/DataLoaderResolver") {
		static readonly layer = Layer.effect(
			this,
			Effect.gen(function* () {
				const rpc = yield* Rpc;
				return RequestResolver.make<ThumbnailRequest>((entries) =>
					rpc
						.VideosGetThumbnails(entries.map((entry) => entry.request.videoId))
						.pipe(
							Effect.flatMap((results) =>
								Effect.forEach(
									entries,
									(entry, index) => {
										const result = results[index];
										return result
											? Request.complete(
													entry,
													Exit.map(result, Option.getOrNull),
												)
											: Request.fail(
													entry,
													new Error("Missing thumbnail result"),
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
