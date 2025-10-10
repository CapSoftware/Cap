import { FetchHttpClient } from "@effect/platform";
import { Layer, ManagedRuntime } from "effect";
import {
	makeUseEffectMutation,
	makeUseEffectQuery,
} from "./effect-react-query";
import { Rpc } from "./Rpcs";
import { ThumbnailRequest } from "./ThumbnailRequest";

export const RuntimeLayer = Layer.mergeAll(
	ThumbnailRequest.DataLoaderResolver.Default,
	Rpc.Default,
	FetchHttpClient.layer,
);

export type RuntimeLayer = typeof RuntimeLayer;

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const useEffectQuery = makeUseEffectQuery(() => EffectRuntime);
export const useEffectMutation = makeUseEffectMutation(() => EffectRuntime);

export const useRpcClient = () => EffectRuntime.runSync(Rpc);
