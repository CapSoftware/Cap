import "server-only";

import { decrypt } from "@cap/database/crypto";
import { serverEnv } from "@cap/env";
import {
	AwsCredentials,
	Database,
	Folders,
	HttpAuthMiddlewareLive,
	ImageUploads,
	Organisations,
	OrganisationsPolicy,
	S3Buckets,
	Spaces,
	SpacesPolicy,
	Users,
	Videos,
	VideosPolicy,
	VideosRepo,
	Tinybird,
	Workflows,
} from "@cap/web-backend";
import { type HttpAuthMiddleware, Video } from "@cap/web-domain";
import {
	FetchHttpClient,
	Headers,
	type HttpApi,
	HttpApiBuilder,
	HttpMiddleware,
	HttpServer,
} from "@effect/platform";
import { RpcClient, RpcMiddleware } from "@effect/rpc";
import {
	Cause,
	Config,
	Effect,
	Exit,
	Layer,
	ManagedRuntime,
	Option,
	Redacted,
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

class WorkflowRpcSecret extends Effect.Service<WorkflowRpcSecret>()(
	"WorkflowRpcSecret",
	{
		sync: () => ({
			authSecret: Option.fromNullable(serverEnv().WORKFLOWS_RPC_SECRET).pipe(
				Option.map(Redacted.make),
			),
		}),
	},
) {}

const WorkflowRpcLive = Layer.unwrapScoped(
	Effect.gen(function* () {
		const url = Option.getOrElse(
			yield* Config.option(Config.string("WORKFLOWS_RPC_URL")),
			() => "http://127.0.0.1:42169",
		);

		const { authSecret } = yield* WorkflowRpcSecret;

		if (Option.isNone(authSecret)) return Layer.empty;

		const authMiddleware = RpcMiddleware.layerClient(
			Workflows.SecretAuthMiddleware,
			({ request }) =>
				Effect.gen(function* () {
					return {
						...request,
						headers: Headers.set(
							request.headers,
							"authorization",
							Redacted.value(authSecret.value),
						),
					};
				}),
		);

		const client = yield* RpcClient.make(Workflows.RpcGroup).pipe(
			Effect.provide(
				Layer.mergeAll(
					RpcClient.layerProtocolHttp({ url }).pipe(
						Layer.provide(Workflows.RpcSerialization),
					),
					authMiddleware,
				),
			),
		);

		return Layer.succeed(Workflows.RpcClient, client);
	}),
);

export const Dependencies = Layer.mergeAll(
	S3Buckets.Default,
	Videos.Default,
	VideosPolicy.Default,
	VideosRepo.Default,
	Tinybird.Default,
	Folders.Default,
	SpacesPolicy.Default,
	OrganisationsPolicy.Default,
	Spaces.Default,
	Users.Default,
	Organisations.Default,
	AwsCredentials.Default,
	ImageUploads.Default,
	WorkflowRpcLive,
	layerTracer,
).pipe(
	Layer.provideMerge(
		Layer.mergeAll(
			Database.Default,
			FetchHttpClient.layer,
			WorkflowRpcSecret.Default,
		),
	),
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
