import type { EditorDefaultStyle } from "@cap/editor-cap-bundle/default-style";
import { Storage } from "@cap/web-backend";
import { HttpApiError } from "@effect/platform";
import { Effect } from "effect";
import { getSignedEditorSources } from "./editor-session";
import {
	DirectRenderForbidden,
	directRenderBlocker,
	directRenderMedia,
	directRenderProbesDisplayAudio,
	planDirectRenderProject,
	type RenderFarmPrepareSupport,
} from "./render-farm-direct-plan";
import { RenderProjectError } from "./render-farm-project";
import { decodeStorageVideo } from "./video-storage";

export const planDirectRender = Effect.fn("planDirectRender")(function* (
	video: Parameters<typeof getSignedEditorSources>[0] & {
		captionsEnabled: boolean;
		defaultStyle?: EditorDefaultStyle | null;
	},
	target: { root: string; recording: string },
	support: RenderFarmPrepareSupport,
	displayHasAudio: (url: string) => Promise<boolean>,
) {
	const editorSources = video.metadata?.editorSources;
	if (!editorSources || editorSources.version !== 1) {
		return { unsupported: "The recording has no editor sources" } as const;
	}
	const sources = yield* getSignedEditorSources(video);
	const blocker = directRenderBlocker(sources);
	if (blocker) return { unsupported: blocker } as const;
	const [storage] = yield* Storage.getAccessForVideo(
		decodeStorageVideo(video),
		{ resolvePublishedOutput: false },
	).pipe(
		Effect.catchTag("StorageError", () =>
			Effect.fail(new HttpApiError.ServiceUnavailable()),
		),
	);
	const media = directRenderMedia(sources, editorSources);
	const [heads, mixedAudioInDisplay] = yield* Effect.all(
		[
			Effect.all(
				media.map(([, key]) =>
					storage
						.headObject(key)
						.pipe(
							Effect.map((head) =>
								head.ContentLength && head.ETag
									? { size: head.ContentLength, etag: head.ETag }
									: null,
							),
						),
				),
				{ concurrency: 4 },
			).pipe(
				Effect.catchTag("StorageError", () =>
					Effect.fail(new HttpApiError.ServiceUnavailable()),
				),
			),
			directRenderProbesDisplayAudio(sources)
				? Effect.tryPromise({
						try: () => displayHasAudio(sources.display.url),
						catch: () => new HttpApiError.ServiceUnavailable(),
					})
				: Effect.succeed(false),
		],
		{ concurrency: 2 },
	);
	return yield* Effect.try({
		try: () =>
			planDirectRenderProject({
				sources,
				editorSources,
				heads: new Map(
					media.map(([, key], index) => [key, heads[index] ?? null]),
				),
				savedAssets: [
					...(video.metadata?.webEditorAssets?.items ?? []),
					...(video.metadata?.webEditorVideos?.items ?? []),
				],
				ownerId: video.ownerId,
				videoId: video.id,
				hasSavedProject: !!video.metadata?.webEditorProject,
				defaultStyle: video.defaultStyle,
				captionsEnabled: video.captionsEnabled,
				target,
				support,
				mixedAudioInDisplay,
			}),
		catch: (error) =>
			error instanceof DirectRenderForbidden
				? new HttpApiError.Forbidden()
				: error instanceof RenderProjectError
					? new HttpApiError.BadRequest()
					: new HttpApiError.ServiceUnavailable(),
	});
});
