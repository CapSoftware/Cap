import { Rpcs } from "@cap/web-domain";
import { Context, Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";

const RpcProtocol = RpcClient.layerProtocolHttp({ url: "/api/erpc" }).pipe(
	Layer.provideMerge(FetchHttpClient.layer),
	Layer.provideMerge(RpcSerialization.layerJson),
);

const makeRpcClient = () => RpcClient.make(Rpcs);

export class Rpc extends Context.Service<
	Rpc,
	Effect.Success<ReturnType<typeof makeRpcClient>>
>()("Rpc") {
	static readonly Default = Layer.effect(this, makeRpcClient()).pipe(
		Layer.provide(RpcProtocol),
	);
}

export const withRpc = <A, E, R>(
	cb: (rpc: Rpc["Service"]) => Effect.Effect<A, E, R>,
) => Effect.flatMap(Rpc, cb);
