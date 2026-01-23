import { HttpServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { RpcAuthMiddlewareLive, RpcsLive } from "@inflight/web-backend";
import { Rpcs } from "@inflight/web-domain";
import { Layer } from "effect";
import { Dependencies } from "@/lib/server";

const rpcLayer = Layer.mergeAll(
	RpcAuthMiddlewareLive,
	RpcsLive,
	RpcSerialization.layerJson,
	HttpServer.layerContext,
);

const { handler } = RpcServer.toWebHandler(Rpcs, {
	layer: Layer.provide(Dependencies)(rpcLayer),
});

export const GET = (r: Request) => handler(r);
export const POST = (r: Request) => handler(r);
