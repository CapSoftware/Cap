import { HttpApi, type HttpApiClient } from "@effect/platform";
import * as Rpc from "@effect/rpc";
import { WorkflowProxy, WorkflowProxyServer } from "@effect/workflow";
import { Loom } from "@inflight/web-domain";
import { Context, Layer, Schema } from "effect";

import { LoomImportVideoLive } from "./Loom/index.ts";

export class InvalidRpcAuth extends Schema.TaggedError<InvalidRpcAuth>()(
	"InvalidRpcAuth",
	{},
) {}
export class SecretAuthMiddleware extends Rpc.RpcMiddleware.Tag<SecretAuthMiddleware>()(
	"SecretAuthMiddleware",
	{ requiredForClient: true, wrap: true, failure: InvalidRpcAuth },
) {}

export const Workflows = [Loom.ImportVideo] as const;
export const RpcGroup =
	WorkflowProxy.toRpcGroup(Workflows).middleware(SecretAuthMiddleware);
export const RpcSerialization = Rpc.RpcSerialization.layerJson;

export class RpcClient extends Context.Tag("Workflows/RpcClient")<
	RpcClient,
	Rpc.RpcClient.RpcClient<
		Rpc.RpcGroup.Rpcs<typeof RpcGroup>,
		Rpc.RpcClientError.RpcClientError
	>
>() {}

const ApiGroup = WorkflowProxy.toHttpApiGroup("workflows", Workflows);
export const Api = HttpApi.make("workflow-api").add(ApiGroup);

export class HttpClient extends Context.Tag("Workflows/HttpClient")<
	HttpClient,
	HttpApiClient.Client<typeof ApiGroup, never, never>
>() {}

export const WorkflowsLayer = Layer.mergeAll(LoomImportVideoLive);

export const WorkflowsRpcLayer =
	WorkflowProxyServer.layerRpcHandlers(Workflows);
