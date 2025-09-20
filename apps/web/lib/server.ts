import "server-only";

import { decrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env";
import {
	Database,
	Folders,
	HttpAuthMiddlewareLive,
	S3Buckets,
	Videos,
	VideosPolicy,
	Workflows,
} from "@cap/web-backend";
import { type HttpAuthMiddleware, Video } from "@cap/web-domain";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import {
	FetchHttpClient,
	type HttpApi,
	HttpApiBuilder,
	HttpApiClient,
	HttpClient,
	HttpClientRequest,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { RpcClient } from "@effect/rpc";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect";
import { isNotFoundError } from "next/dist/client/components/not-found";
import { cookies } from "next/headers";
import { allowedOrigins } from "@/utils/cors";
import { getTracingConfig } from "./tracing";

export const TracingLayer = NodeSdk.layer(getTracingConfig);

const CookiePasswordAttachmentLive = Layer.effect(
	Video.VideoPasswordAttachment,
	Effect.gen(function* () {
		const password = Option.fromNullable(
			yield* Effect.promise(async () => {
				const pw = cookies().get("x-cap-password")?.value;
				if (pw) return decrypt(pw);
			}),
		);
		return { password };
	}),
);

const WorkflowRpcClient = Layer.scoped(
	Workflows.RpcClient,
	Effect.gen(function* () {
		const envs = Option.zipWith(
			Option.fromNullable(serverEnv().REMOTE_WORKFLOW_URL),
			Option.fromNullable(serverEnv().REMOTE_WORKFLOW_SECRET),
			(l, r) => [l, r] as const,
		);

		return yield* Option.match(envs, {
			onNone: () =>
				RpcClient.make(Workflows.RpcGroup).pipe(
					Effect.provide(
						RpcClient.layerProtocolHttp({
							url: "http://localhost:42169/rpc",
						}).pipe(Layer.provide(Workflows.RpcSerialization)),
					),
				),
			onSome: ([url, secret]) =>
				RpcClient.make(Workflows.RpcGroup).pipe(
					Effect.provide(
						RpcClient.layerProtocolHttp({
							url,
							transformClient: HttpClient.mapRequest(
								HttpClientRequest.setHeader("Authorization", `Token ${secret}`),
							),
						}).pipe(Layer.provide(Workflows.RpcSerialization)),
					),
				),
		});
	}),
);

const WorkflowHttpClient = Layer.scoped(
	Workflows.HttpClient,
	Effect.gen(function* () {
		const a = yield* HttpApiClient.make(Workflows.Api, {
			baseUrl: "http://localhost:42169",
		});
		return a;
	}),
);

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Videos.Default,
	VideosPolicy.Default,
	Folders.Default,
	Database.Default,
	WorkflowRpcClient,
	WorkflowHttpClient,
).pipe(Layer.provideMerge(Layer.mergeAll(TracingLayer, FetchHttpClient.layer)));

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
