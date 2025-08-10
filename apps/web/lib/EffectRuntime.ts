import { Layer, ManagedRuntime } from "effect";
import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

import { Rpc } from "./Rpcs";
import {
  makeUseEffectMutation,
  makeUseEffectQuery,
} from "./effect-react-query";

const TracingLayer = WebSdk.layer(() => ({
  resource: { serviceName: "cap-web" },
  spanProcessor: [new BatchSpanProcessor(new OTLPTraceExporter())],
}));

const RuntimeLayer = Layer.mergeAll(Rpc.Default, TracingLayer);

export type RuntimeLayer = typeof RuntimeLayer;

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const useEffectQuery = makeUseEffectQuery(() => EffectRuntime);
export const useEffectMutation = makeUseEffectMutation(() => EffectRuntime);

export const useRpcClient = () => EffectRuntime.runSync(Rpc);
