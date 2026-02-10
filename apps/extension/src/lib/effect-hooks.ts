import type { Effect, Exit } from "effect";
import { useCallback } from "react";
import { EffectRuntime, getRpcClient } from "./rpc";

export const useRpcClient = () => getRpcClient();

export const useEffectMutation = <TData, TError, TVariables, TR>(options: {
	mutationFn: (variables: TVariables) => Effect.Effect<TData, TError, TR>;
}) => {
	const mutateAsync = useCallback(
		(variables: TVariables): Promise<Exit.Exit<TData, TError>> =>
			EffectRuntime.runPromiseExit(options.mutationFn(variables)) as Promise<
				Exit.Exit<TData, TError>
			>,
		[options.mutationFn],
	);

	return { mutateAsync };
};
