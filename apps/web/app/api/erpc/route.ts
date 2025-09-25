import { RpcAuthMiddlewareLive, RpcsLive } from "@cap/web-backend";
import { Rpcs } from "@cap/web-domain";
import { HttpServer } from "@effect/platform";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Layer } from "effect";
import { Dependencies } from "@/lib/server";

const { handler } = RpcServer.toWebHandler(Rpcs, {
	layer: Layer.mergeAll(
		RpcAuthMiddlewareLive,
		RpcsLive,
		RpcSerialization.layerJson,
		HttpServer.layerContext,
	).pipe(Layer.provideMerge(Dependencies)),
});

export const GET = handler as any;
export const POST = handler as any;
