import { Layer, ManagedRuntime } from "effect";

import { Rpc } from "./Rpcs";
import {
  makeUseEffectMutation,
  makeUseEffectQuery,
} from "./effect-react-query";
import { TracingLayer } from "./tracing";

const RuntimeLayer = Layer.mergeAll(Rpc.Default, TracingLayer);

export type RuntimeLayer = typeof RuntimeLayer;

export const EffectRuntime = ManagedRuntime.make(RuntimeLayer);

export const useEffectQuery = makeUseEffectQuery(() => EffectRuntime);
export const useEffectMutation = makeUseEffectMutation(() => EffectRuntime);

export const useRpcClient = () => EffectRuntime.runSync(Rpc);
