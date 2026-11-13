import { Cause, Effect } from "effect";
import { refusalMessage, settled } from "@/lib/infra-action-result";

const asError = (error: unknown) =>
	error instanceof Error ? error : new Error(String(error));

export const runAction = <T>(action: () => Promise<T>) =>
	Effect.tryPromise({ try: () => settled(action()), catch: asError });

export const actionMessage = (cause: Cause.Cause<Error>, fallback: string) =>
	refusalMessage(Cause.squash(cause), fallback);
