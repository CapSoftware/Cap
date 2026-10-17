import { RpcAuthMiddlewareLive, RpcsLive } from "@cap/web-backend";
import { Rpcs } from "@cap/web-domain";
import { Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";
import { Dependencies } from "@/lib/server";

const routes = RpcServer.layerHttp({
	group: Rpcs,
	path: "/api/erpc",
	protocol: "http",
}).pipe(
	Layer.provide(
		Layer.mergeAll(
			RpcAuthMiddlewareLive,
			RpcsLive,
			RpcSerialization.layerJson,
		).pipe(Layer.provide(Dependencies)),
	),
	Layer.provide(HttpServer.layerServices),
);

const { handler } = HttpRouter.toWebHandler(routes);

export const GET = (r: Request) => handler(r);
export const POST = (r: Request) => handler(r);
