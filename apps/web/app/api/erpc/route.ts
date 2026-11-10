import {
	RpcAuthMiddlewareLive,
	RpcsLive,
	VideoDownloadGate,
} from "@cap/web-backend";
import { Rpcs } from "@cap/web-domain";
import { HttpServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Effect, Layer } from "effect";
import { Dependencies } from "@/lib/server";
import { canDownloadCurrentVideo } from "@/lib/video-download-access";

const VideoDownloadGateLive = Layer.succeed(VideoDownloadGate, {
	allows: (videoId, viewer) =>
		Effect.tryPromise(() => canDownloadCurrentVideo(videoId, viewer)).pipe(
			Effect.catchAll((error) =>
				Effect.logError("Video download access check failed", error).pipe(
					Effect.as(false),
				),
			),
		),
});

const rpcLayer = Layer.mergeAll(
	RpcAuthMiddlewareLive,
	Layer.provide(RpcsLive, VideoDownloadGateLive),
	RpcSerialization.layerJson,
	HttpServer.layerContext,
);

const { handler } = RpcServer.toWebHandler(Rpcs, {
	layer: Layer.provide(Dependencies)(rpcLayer),
});

export const GET = (r: Request) => handler(r);
export const POST = (r: Request) => handler(r);
