import "server-only";

import { db } from "@cap/database";
import {
	Database,
	DatabaseError,
	Folders,
	HttpAuthMiddlewareLive,
	S3Buckets,
	Videos,
	VideosPolicy,
} from "@cap/web-backend";
import { Video, type HttpAuthMiddleware } from "@cap/web-domain";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import {
	type HttpApi,
	HttpApiBuilder,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { Effect, Layer, ManagedRuntime, Option } from "effect";
import { cookies } from "next/headers";
import { allowedOrigins } from "@/utils/cors";
import { getTracingConfig } from "./tracing";

const DatabaseLive = Layer.sync(Database, () => ({
	execute: (cb) =>
		Effect.tryPromise({
			try: () => cb(db()),
			catch: (error) => new DatabaseError({ message: String(error) }),
		}),
}));

const TracingLayer = NodeSdk.layer(getTracingConfig);

const CookiesPasswordLive = Layer.sync(Video.VideoPasswordAttachment, () =>
	({ password: Option.fromNullable(cookies().get("x-cap-password")?.value) })
)

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Videos.Default,
	VideosPolicy.Default,
	Folders.Default,
	TracingLayer,
	CookiesPasswordLive
).pipe(Layer.provideMerge(DatabaseLive));

export const EffectRuntime = ManagedRuntime.make(Dependencies);

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
		HttpApiBuilder.toWebHandler,
	);
