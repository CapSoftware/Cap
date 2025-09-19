import "server-only";

import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import {
	Database,
	DatabaseError,
	Folders,
	HttpAuthMiddlewareLive,
	S3Buckets,
	Videos,
	VideosPolicy,
} from "@cap/web-backend";
import { type HttpAuthMiddleware, Video } from "@cap/web-domain";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import {
	type HttpApi,
	HttpApiBuilder,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { isNotFoundError } from "next/dist/client/components/not-found";
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

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Videos.Default,
	VideosPolicy.Default,
	Folders.Default,
	TracingLayer,
).pipe(Layer.provideMerge(DatabaseLive));

// purposefully not exposed
const EffectRuntime = ManagedRuntime.make(Dependencies);

export const runPromise = <A, E>(
	effect: Effect.Effect<A, E, Layer.Layer.Success<typeof Dependencies>>,
) =>
	EffectRuntime.runPromiseExit(
		effect.pipe(Effect.provide(CookiePasswordAttachmentLive)),
	).then((res) => {
		if (Exit.isFailure(res)) {
			if (Cause.isDieType(res.cause) && isNotFoundError(res.cause.defect)) {
				throw res.cause.defect;
			}

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
		if (
			Exit.isFailure(res) &&
			Cause.isDieType(res.cause) &&
			isNotFoundError(res.cause.defect)
		) {
			throw res.cause.defect;
		}

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
		HttpApiBuilder.toWebHandler,
	);
