import { createServer } from "node:http";
import { Database, S3Buckets, Videos, Workflows } from "@cap/web-backend";
import { ClusterWorkflowEngine, RunnerAddress } from "@effect/cluster";
import * as NodeSdk from "@effect/opentelemetry/NodeSdk";
import { FetchHttpClient, HttpApiBuilder, HttpServer } from "@effect/platform";
import {
	NodeClusterRunnerSocket,
	NodeHttpServer,
	NodeRuntime,
} from "@effect/platform-node";
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

const ClusterWorkflowLive = ClusterWorkflowEngine.layer.pipe(
	Layer.provide(
		NodeClusterRunnerSocket.layer({
			storage: "sql",
			shardingConfig: {
				runnerAddress: Option.some(RunnerAddress.make("localhost", 42069)),
			},
		}),
	),
	Layer.provide(SqlLayer),
);

const WorkflowApiLive = HttpApiBuilder.api(Workflows.Api).pipe(
	Layer.provide(
		WorkflowProxyServer.layerHttpApi(
			Workflows.Api,
			"workflows",
			Workflows.Workflows,
		),
	),
	Layer.provide(Workflows.WorkflowsLayer),
	Layer.provide(ClusterWorkflowLive),
	HttpServer.withLogAddress,
);

const TracingLayer = NodeSdk.layer(() => ({
	resource: { serviceName: "cap-workflow-runner" },
	spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter({}))],
}));

HttpApiBuilder.serve().pipe(
	Layer.provide(WorkflowApiLive),
	Layer.provide(NodeHttpServer.layer(createServer, { port: 42169 })),
	Layer.provide(Videos.Default),
	Layer.provide(S3Buckets.Default),
	Layer.provide(Database.Default),
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(TracingLayer),
	Layer.launch,
	NodeRuntime.runMain,
);
