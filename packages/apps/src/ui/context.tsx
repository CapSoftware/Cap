"use client";

import type {
	MutateOptions,
	QueryClient,
	QueryFunctionContext,
	QueryKey,
	SkipToken,
	UseMutationOptions,
	UseMutationResult,
	UseQueryOptions,
	UseQueryResult,
} from "@tanstack/react-query";
import type * as Cause from "effect/Cause";
import type * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import type { ReactNode } from "react";
import { createContext, useContext } from "react";

type Override<TTargetA, TTargetB> = {
	[TKey in keyof TTargetA]: TKey extends keyof TTargetB
		? TTargetB[TKey]
		: TTargetA[TKey];
};

type UseEffectQueryOptions<
	TData,
	TError,
	ThrowOnDefect extends boolean,
	TExposedError,
	TQueryKey extends QueryKey,
> = {
	throwOnDefect?: ThrowOnDefect;
} & Override<
	UseQueryOptions<TData, TExposedError, TData, TQueryKey>,
	{
		queryFn?:
			| ((
					context: QueryFunctionContext<TQueryKey, never>,
				) => Effect.Effect<TData, TError, any>)
			| SkipToken;
	}
>;

export type UseEffectQueryHook = <
	TData = unknown,
	TError = unknown,
	ThrowOnDefect extends boolean = false,
	TExposedError = ThrowOnDefect extends true
		? TError
		: Cause.Cause<TError>,
	TQueryKey extends QueryKey = QueryKey,
>(
	options: UseEffectQueryOptions<
		TData,
		TError,
		ThrowOnDefect,
		TExposedError,
		TQueryKey
	>,
) => UseQueryResult<TData, TExposedError>;

type UseEffectMutationOptions<
	TData,
	TError,
	ThrowOnDefect extends boolean,
	TExposedError,
	TVariables,
	TContext,
> = {
	throwOnDefect?: ThrowOnDefect;
} & Override<
	Omit<
		UseMutationOptions<TData, TExposedError, TVariables, TContext>,
		"retry" | "retryDelay"
	>,
	{
		mutationFn?: (
			variables: TVariables,
		) => Effect.Effect<TData, TError, any>;
	}
>;

export type UseEffectMutationHook = <
	TData = unknown,
	TError = unknown,
	ThrowOnDefect extends boolean = false,
	TExposedError = ThrowOnDefect extends true
		? TError
		: Cause.Cause<TError>,
	TVariables = void,
	TContext = unknown,
>(
	options: UseEffectMutationOptions<
		TData,
		TError,
		ThrowOnDefect,
		TExposedError,
		TVariables,
		TContext
	>,
) => Override<
	UseMutationResult<TData, TExposedError, TVariables, TContext>,
	{
		mutateAsync: (
			variables: TVariables,
			options?: MutateOptions<
				TData,
				Cause.Cause<TError>,
				TVariables,
				TContext
			>,
		) => Promise<Exit.Exit<TData, TError>>;
		mutate: (
			variables: TVariables,
			options?: MutateOptions<
				TData,
				Cause.Cause<TError>,
				TVariables,
				TContext
			>,
		) => void;
	}
>;

export type WithRpc = <A, E, R>(
	cb: (rpc: unknown) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, unknown>;

export type ToastApi = {
	error: (message: string) => void;
	success: (message: string) => void;
};

export type AppsUiContextValue = {
	useEffectQuery: UseEffectQueryHook;
	useEffectMutation: UseEffectMutationHook;
	withRpc: WithRpc;
	useQueryClient: () => QueryClient;
	toast: ToastApi;
};

const AppsUiContext = createContext<AppsUiContextValue | null>(null);

const AppsUiProvider = ({
	value,
	children,
}: {
	value: AppsUiContextValue;
	children: ReactNode;
}) => <AppsUiContext.Provider value={value}>{children}</AppsUiContext.Provider>;

const useAppsUi = () => {
	const context = useContext(AppsUiContext);

	if (!context) {
		throw new Error("useAppsUi must be used within an AppsUiProvider");
	}

	return context;
};

export { AppsUiProvider, useAppsUi };
