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
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import {
	FetchHttpClient,
	HttpMiddleware,
	HttpRouter,
	HttpServer,
} from "effect/http";
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
	effect: Effect.Effect<A, E, Layer.Success<typeof Dependencies>>,
) =>
	EffectRuntime.runPromiseExit(
		effect.pipe(Effect.provide(CookiePasswordAttachmentLive)),
	).then((res) => {
		if (Exit.isFailure(res)) {
			const reason = res.cause.reasons[0];
			if (res.cause.reasons.length === 1 && reason && Cause.isDieReason(reason))
				throw reason.defect;
			throw res;
		}

		return res.value;
	});

export const runPromiseExit = <A, E>(
	effect: Effect.Effect<A, E, Layer.Success<typeof Dependencies>>,
) =>
	EffectRuntime.runPromiseExit(
		effect.pipe(Effect.provide(CookiePasswordAttachmentLive)),
	).then((res) => {
		if (Exit.isFailure(res)) {
			const reason = res.cause.reasons[0];
			if (res.cause.reasons.length === 1 && reason && Cause.isDieReason(reason))
				throw reason.defect;
		}
		return res;
	});

const cors = HttpRouter.cors({
	allowedOrigins,
	credentials: true,
	allowedMethods: ["GET", "HEAD", "POST", "DELETE", "OPTIONS"],
	allowedHeaders: ["Content-Type", "Authorization", "sentry-trace", "baggage"],
});

export const apiToHandler = (
	api: Layer.Layer<
		never,
		never,
		| Layer.Success<typeof Dependencies>
		| HttpAuthMiddleware
		| HttpRouter.HttpRouter
		| HttpRouter.Request<
				"Requires",
				Layer.Success<typeof Dependencies> | Video.VideoPasswordAttachment
		  >
		| Layer.Success<typeof HttpServer.layerServices>
	>,
) => {
	const routes = Layer.mergeAll(api, cors).pipe(
		Layer.provide(HttpAuthMiddlewareLive),
		Layer.provide(Dependencies),
		Layer.provide(HttpServer.layerServices),
		Layer.provide(
			Layer.succeed(
				HttpMiddleware.SpanNameGenerator,
				(req) => `${req.method} ${req.url}`,
			),
		),
	);
	const { handler } = HttpRouter.toWebHandler(routes);
	return async (req: Request) => {
		const passwords = await Effect.runPromise(
			Video.VideoPasswordAttachment.pipe(
				Effect.provide(CookiePasswordAttachmentLive),
			),
		);
		const context = Context.add(
			await EffectRuntime.context(),
			Video.VideoPasswordAttachment,
			passwords,
		);
		return handler(req, context);
	};
};
