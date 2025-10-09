import "server-only";

import { decrypt } from "@cap/database/crypto";
import {
	Database,
	Folders,
	HttpAuthMiddlewareLive,
	OrganisationsPolicy,
	S3Buckets,
	Spaces,
	SpacesPolicy,
	Videos,
	VideosPolicy,
	Workflows,
} from "@cap/web-backend";
import { type HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	FetchHttpClient,
	type HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { RpcClient } from "@effect/rpc";
import {
	Cause,
	Config,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
} from "effect";
import { cookies } from "next/headers";

import { allowedOrigins } from "@/utils/cors";
import { layerTracer } from "./tracing";

const CookiePasswordAttachmentLive = Layer.effect(
	Video.VideoPasswordAttachment,
	Effect.gen(function* () {
		const password = Option.fromNullable(
			yield* Effect.promise(async () => {
				const pw = (await cookies()).get("x-cap-password")?.value;
				if (pw) return decrypt(pw);
			}),
		);
		return { password };
	}),
);

const WorkflowRpcLive = Layer.scoped(
	Workflows.RpcClient,
	Effect.gen(function* () {
		const url = Option.getOrElse(
			yield* Config.option(Config.string("REMOTE_WORKFLOW_URL")),
			() => "http://127.0.0.1:42169",
		);

		return yield* RpcClient.make(Workflows.RpcGroup).pipe(
			Effect.provide(
				RpcClient.layerProtocolHttp({ url }).pipe(
					Layer.provide(Workflows.RpcSerialization),
				),
			),
		);
	}),
);

const WorkflowHttpLive = Layer.scoped(
	Workflows.HttpClient,
	Effect.gen(function* () {
		const url = Option.getOrElse(
			yield* Config.option(Config.string("REMOTE_WORKFLOW_URL")),
			() => "http://127.0.0.1:42169",
		);

		return yield* HttpApiClient.make(Workflows.Api, { baseUrl: url });
	}),
);

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Videos.Default,
	VideosPolicy.Default,
	Folders.Default,
	SpacesPolicy.Default,
	OrganisationsPolicy.Default,
	Spaces.Default,
	WorkflowRpcLive,
	WorkflowHttpLive,
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
	allowedMethods: ["GET", "HEAD", "POST", "OPTIONS"],
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
		Layer.provideMerge(Dependencies),
		Layer.merge(HttpServer.layerContext),
		Layer.provide(cors),
		Layer.provide(
			HttpApiBuilder.middleware(Effect.provide(CookiePasswordAttachmentLive)),
		),
		Layer.provide(layerTracer),
		HttpApiBuilder.toWebHandler,
		(v) => (req: Request) => v.handler(req),
	);
