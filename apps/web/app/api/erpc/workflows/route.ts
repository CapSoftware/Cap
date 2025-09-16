// import { Workflows } from "@cap/web-domain";
// import { HttpServer } from "@effect/platform";
// import { RpcSerialization, RpcServer } from "@effect/rpc";
// import { WorkflowProxy, WorkflowProxyServer } from "@effect/workflow";
// import { Layer } from "effect";
// import { Dependencies } from "@/lib/server";

// const { handler } = RpcServer.toWebHandler(
// 	WorkflowProxy.toRpcGroup(Workflows.Workflows),
// 	{
// 		layer: Layer.mergeAll(
// 			RpcSerialization.layerJson,
// 			HttpServer.layerContext,
// 			Dependencies,
// 		),
// 	},
// );

// export const GET = handler;
// export const POST = handler;
