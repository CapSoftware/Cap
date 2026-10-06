import "server-only";

import {
	AwsCredentials,
	Database,
	Extensions,
	Folders,
	HttpAuthMiddlewareLive,
	ImageUploads,
	Organisations,
	OrganisationsPolicy,
	S3Buckets,
	Spaces,
	SpacesPolicy,
	Storage,
	Tinybird,
	Users,
	Videos,
	VideosPolicy,
	VideosRepo,
} from "@cap/web-backend";
import { type HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	FetchHttpClient,
	type HttpApi,
	HttpApiBuilder,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { Cause, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { allowedOrigins } from "@/utils/cors";
import { getVerifiedPasswordHashes } from "./password-cookie";
import { layerTracer } from "./tracing";

const CookiePasswordAttachmentLive = Layer.effect(
	Video.VideoPasswordAttachment,
	Effect.gen(function* () {
		const passwords = yield* Effect.promise(getVerifiedPasswordHashes);
		return { passwords };
	}),
);

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Storage.Default,
	Videos.Default,
	VideosPolicy.Default,
	VideosRepo.Default,
	Tinybird.Default,
	Extensions.Default,
	Folders.Default,
	SpacesPolicy.Default,
	OrganisationsPolicy.Default,
	Spaces.Default,
	Users.Default,
	Organisations.Default,
	AwsCredentials.Default,
	ImageUploads.Default,
	layerTracer,
).pipe(
	Layer.provideMerge(Layer.mergeAll(Database.Default, FetchHttpClient.layer)),
);

// purposefully not exposed
const EffectRuntime = ManagedRuntime.make(Dependencies);

export const runPromise = <A, E>(
	effect: Effect.Effect<A, E, Layer.Layer.Success<typeof Dependencies>>,
) =>
	EffectRuntime.runPromiseExit(
		effect.pipe(Effect.provide(CookiePasswordAttachmentLive)),
	).then((res) => {
		if (Exit.isFailure(res)) {
			if (Cause.isDieType(res.cause)) throw res.cause.defect;
			throw res;
		}

		return res.value;
	});

export const runPromiseExit = <A, E>(
	effect: Effect.Effect<A, E, Layer.Layer.Success<typeof Dependencies>>,
) =>
	EffectRuntime.runPromiseExit(
		effect.pipe(Effect.provide(CookiePasswordAttachmentLive)),
	).then((res) => {
		if (Exit.isFailure(res) && Cause.isDieType(res.cause))
			throw res.cause.defect;
		return res;
	});

const cors = HttpApiBuilder.middlewareCors({
	allowedOrigins,
	credentials: true,
	allowedMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

export const apiToHandler = (
	api: Layer.Layer<
		HttpApi.Api,
		never,
		Layer.Layer.Success<typeof Dependencies> | HttpAuthMiddleware
	>,
) =>
	api.pipe(
		HttpMiddleware.withSpanNameGenerator((req) => `${req.method} ${req.url}`),
		Layer.provideMerge(HttpAuthMiddlewareLive),
		Layer.merge(HttpServer.layerContext),
		Layer.provide(cors),
		Layer.provide(
			HttpApiBuilder.middleware(Effect.provide(CookiePasswordAttachmentLive)),
		),
		Layer.provide(layerTracer),
		Layer.provideMerge(Dependencies),
		HttpApiBuilder.toWebHandler,
		(v) => (req: Request) => v.handler(req),
	);
