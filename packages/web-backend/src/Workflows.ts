import { Loom } from "@cap/web-domain";
import { HttpApi, type HttpApiClient } from "@effect/platform";
import * as Rpc from "@effect/rpc";
import { WorkflowProxy, WorkflowProxyServer } from "@effect/workflow";
import { Context, Layer } from "effect";

import { LoomImportVideoLive } from "./Loom/index.ts";

export const Workflows = [Loom.ImportVideo] as const;
export const RpcGroup = WorkflowProxy.toRpcGroup(Workflows);
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
