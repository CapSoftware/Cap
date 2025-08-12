import { Rpcs } from "@cap/web-domain";
import { RpcSerialization, RpcServer } from "@effect/rpc";
import { Layer } from "effect";
import { RpcAuthMiddlewareLive, RpcsLive } from "@cap/web-backend";
import { HttpServer } from "@effect/platform";
import { Dependencies } from "@/lib/server";

const { handler } = RpcServer.toWebHandler(Rpcs, {
  layer: Layer.mergeAll(
    RpcAuthMiddlewareLive,
    RpcsLive,
    RpcSerialization.layerJson,
    HttpServer.layerContext
  ).pipe(Layer.provideMerge(Dependencies)),
});

export const GET = handler;
export const POST = handler;
