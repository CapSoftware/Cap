import { createServer } from "node:http";
import { Database, S3Buckets, Videos, Workflows } from "@cap/web-backend";
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

import { ContainerMetadata } from "../cluster/container-metadata.ts";
import { HealthServerLive } from "./health-server.ts";

const SqlLayer = Layer.unwrapEffect(
	Effect.gen(function* () {
		const url = yield* Config.string("DATABASE_URL").pipe((v) =>
			Config.redacted(v),
		);
		return MysqlClient.layer({ url });
	}),
);

const ClusterWorkflowLive = Layer.unwrapEffect(
	Effect.gen(function* () {
		const containerMeta = yield* ContainerMetadata;
		return ClusterWorkflowEngine.layer.pipe(
			Layer.provide(
				NodeClusterRunnerSocket.layer({
					storage: "sql",
					shardingConfig: {
						runnerAddress: Option.some(
							RunnerAddress.make(containerMeta.ipAddress, containerMeta.port),
						),
					},
				}),
			),
			Layer.provide(SqlLayer),
		);
	}),
).pipe(Layer.provide(ContainerMetadata.Default));

const RpcsLive = RpcServer.layer(Workflows.RpcGroup).pipe(
	Layer.provide(WorkflowProxyServer.layerRpcHandlers(Workflows.Workflows)),
	Layer.provide(Workflows.WorkflowsLayer),
	Layer.provide(ClusterWorkflowLive),
);
const RpcProtocol = RpcServer.layerProtocolHttp({ path: "/" }).pipe(
	Layer.provide(Workflows.RpcSerialization),
);

const WorkflowApiHttpLive = HttpApiBuilder.api(Workflows.Api).pipe(
	Layer.provide(
		WorkflowProxyServer.layerHttpApi(
			Workflows.Api,
			"workflows",
			Workflows.Workflows,
		),
	),
	Layer.provide(Workflows.WorkflowsLayer),
	Layer.provide(ClusterWorkflowLive),
);

const TracingLayer = Layer.unwrapEffect(
	Effect.gen(function* () {
		const exporter = Option.match(
			yield* Config.option(
				Config.all([
					Config.string("AXIOM_API_TOKEN"),
					Config.string("AXIOM_DOMAIN"),
					Config.string("AXIOM_DATASET"),
				]),
			),
			{
				onNone: () => new OTLPTraceExporter({}),
				onSome: ([token, domain, dataset]) => {
					return new OTLPTraceExporter({
						url: `https://${domain}/v1/traces`, // Axiom API endpoint for trace data
						headers: {
							Authorization: `Bearer ${token}`, // Replace API_TOKEN with your actual API token
							"X-Axiom-Dataset": dataset, // Replace DATASET_NAME with your dataset
						},
					});
				},
			},
		);

		return NodeSdk.layer(() => ({
			resource: { serviceName: "cap-workflow-runner" },
			spanProcessor: [new BatchSpanProcessor(exporter)],
		}));
	}),
);

HttpRouter.Default.serve(HttpMiddleware.logger).pipe(
	Layer.provide(RpcsLive),
	Layer.provide(RpcProtocol),
	Layer.provide(WorkflowApiHttpLive),
	Layer.provide(NodeHttpServer.layer(createServer, { port: 42169 })),
	Layer.provide(Videos.Default),
	Layer.provide(S3Buckets.Default),
	Layer.provide(Database.Default),
	Layer.provide(FetchHttpClient.layer),
	Layer.provide(SqlLayer),
	Layer.provide(TracingLayer),
	Layer.provide(HealthServerLive),
	Layer.launch,
	NodeRuntime.runMain,
);
