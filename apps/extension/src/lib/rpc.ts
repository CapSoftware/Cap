import { RpcAuthMiddleware, Rpcs } from "@cap/web-domain";
import { FetchHttpClient, Headers } from "@effect/platform";
import { RpcClient, RpcMiddleware, RpcSerialization } from "@effect/rpc";
import { Effect, Layer, ManagedRuntime } from "effect";
import { CAP_WEB_ORIGIN } from "./cap-web";

let authToken: string | null = null;

export const setRpcAuthToken = (token: string | null) => {
	authToken = token;
};

const AuthMiddleware = RpcMiddleware.layerClient(
	RpcAuthMiddleware,
	({ request }) =>
		Effect.sync(() => {
			if (!authToken) return { ...request };

			return {
				...request,
				headers: Headers.set(
					request.headers,
					"authorization",
					`Bearer ${authToken}`,
				),
			};
		}),
);

const RpcProtocol = RpcClient.layerProtocolHttp({
	url: `${CAP_WEB_ORIGIN}/api/erpc`,
}).pipe(
	Layer.provideMerge(FetchHttpClient.layer),
	Layer.provideMerge(RpcSerialization.layerJson),
	Layer.provideMerge(AuthMiddleware),
);

export class Rpc extends Effect.Service<Rpc>()("Rpc", {
	scoped: RpcClient.make(Rpcs),
	dependencies: [RpcProtocol],
}) {}

const RuntimeLayer = Layer.mergeAll(Rpc.Default, FetchHttpClient.layer);

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const getRpcClient = () => EffectRuntime.runSync(Rpc);
