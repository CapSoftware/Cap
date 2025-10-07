import { createServer } from "node:http";
// import { Database, S3Buckets, Videos, Workflows } from "@cap/web-backend";
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import {
	FetchHttpClient,
	HttpApiBuilder,
	HttpMiddleware,
	HttpRouter,
} from "@effect/platform";
import {
	NodeClusterRunnerSocket,
	NodeHttpServer,
	NodeRuntime,
} from "@effect/platform-node";
import { RpcServer } from "@effect/rpc";
import { MysqlClient } from "@effect/sql-mysql2";
import { WorkflowProxyServer } from "@effect/workflow";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { Config, Effect, Layer, Option } from "effect";

const SqlLayer = Layer.unwrapEffect(
	Effect.gen(function* () {
		const url = yield* Config.string("DATABASE_URL").pipe((v) =>
			Config.redacted(v),
		);
		return MysqlClient.layer({ url });
	}),
);

// const ClusterWorkflowLive = ClusterWorkflowEngine.layer.pipe(
// 	Layer.provide(
// 		NodeClusterRunnerSocket.layer({
// 			storage: "sql",
// 			shardingConfig: {
// 				runnerAddress: Option.some(RunnerAddress.make("localhost", 42069)),
// 			},
// 		}),
// 	),
// 	Layer.provide(SqlLayer),
// );

// const RpcsLive = RpcServer.layer(Workflows.RpcGroup).pipe(
// 	Layer.provide(WorkflowProxyServer.layerRpcHandlers(Workflows.Workflows)),
// 	Layer.provide(Workflows.WorkflowsLayer),
// 	Layer.provide(ClusterWorkflowLive),
// );
// const RpcProtocol = RpcServer.layerProtocolHttp({ path: "/" }).pipe(
// 	Layer.provide(Workflows.RpcSerialization),
// );

// const WorkflowApiHttpLive = HttpApiBuilder.api(Workflows.Api).pipe(
// 	Layer.provide(
// 		WorkflowProxyServer.layerHttpApi(
// 			Workflows.Api,
// 			"workflows",
// 			Workflows.Workflows,
// 		),
// 	),
// 	Layer.provide(Workflows.WorkflowsLayer),
// 	Layer.provide(ClusterWorkflowLive),
// );

// const TracingLayer = NodeSdk.layer(() => ({
// 	resource: { serviceName: "cap-workflow-runner" },
// 	spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter({}))],
// }));

// const Main = HttpRouter.Default.serve(HttpMiddleware.logger)
// 	.pipe(
// 		Layer.provide(RpcsLive),
// 		Layer.provide(RpcProtocol),
// 		Layer.provide(NodeHttpServer.layer(createServer, { port: 42169 })),
// 	)
// 	.pipe(
// 		Layer.provide(Videos.Default),
// 		Layer.provide(S3Buckets.Default),
// 		Layer.provide(Database.Default),
// 		Layer.provide(FetchHttpClient.layer),
// 		Layer.provide(TracingLayer),
// 	);

NodeRuntime.runMain(Layer.launch(SqlLayer));
