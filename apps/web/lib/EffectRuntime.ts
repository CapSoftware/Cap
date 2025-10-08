import * as WebSdk from "@effect/opentelemetry/WebSdk";
import { FetchHttpClient } from "@effect/platform";
import { Layer, ManagedRuntime } from "effect";
import {
	makeUseEffectMutation,
	makeUseEffectQuery,
} from "./effect-react-query";
import { Rpc } from "./Rpcs";
import { getTracingConfig } from "./tracing";

// const TracingLayer = WebSdk.layer(getTracingConfig);

const RuntimeLayer = Layer.mergeAll(
	Rpc.Default,
	// TracingLayer,
	FetchHttpClient.layer,
);

export type RuntimeLayer = typeof RuntimeLayer;

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const useEffectQuery = makeUseEffectQuery(() => EffectRuntime);
export const useEffectMutation = makeUseEffectMutation(() => EffectRuntime);

export const useRpcClient = () => EffectRuntime.runSync(Rpc);
