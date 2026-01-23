import { FetchHttpClient } from "@effect/platform";
import { RpcClient, RpcSerialization } from "@effect/rpc";
import { Rpcs } from "@inflight/web-domain";
import { Effect, Layer } from "effect";

const RpcProtocol = RpcClient.layerProtocolHttp({ url: "/api/erpc" }).pipe(
	Layer.provideMerge(FetchHttpClient.layer),
	Layer.provideMerge(RpcSerialization.layerJson),
);

export class Rpc extends Effect.Service<Rpc>()("Rpc", {
	scoped: RpcClient.make(Rpcs),
	dependencies: [RpcProtocol],
}) {}

export const withRpc = <A, E, R>(cb: (rpc: Rpc) => Effect.Effect<A, E, R>) =>
	Effect.flatMap(Rpc, cb);
