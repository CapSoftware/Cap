import { FetchHttpClient } from "@effect/platform";
import { Layer, ManagedRuntime } from "effect";
import {
	makeUseEffectMutation,
	makeUseEffectQuery,
} from "./effect-react-query";
import { AnalyticsRequest } from "./Requests/AnalyticsRequest";
import { ThumbnailRequest } from "./Requests/ThumbnailRequest";
import { Rpc } from "./Rpcs";

export const RuntimeLayer = Layer.mergeAll(
	ThumbnailRequest.DataLoaderResolver.Default,
	AnalyticsRequest.DataLoaderResolver.Default,
	Rpc.Default,
	FetchHttpClient.layer,
);

export type RuntimeLayer = typeof RuntimeLayer;

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const useEffectQuery = makeUseEffectQuery(() => EffectRuntime);
export const useEffectMutation = makeUseEffectMutation(() => EffectRuntime);

export const useRpcClient = () => EffectRuntime.runSync(Rpc);
