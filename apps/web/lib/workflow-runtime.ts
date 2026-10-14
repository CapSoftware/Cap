import { AwsCredentials } from "@cap/web-backend/src/Aws";
import { Organisations } from "@cap/web-backend/src/Organisations/index";
import { Storage } from "@cap/web-backend/src/Storage/index";
import { Cause, type Effect, Exit, Layer, ManagedRuntime } from "effect";

const WorkflowDependencies = Layer.mergeAll(
	Storage.Default,
	AwsCredentials.Default,
	Organisations.Default,
);

const WorkflowRuntime = ManagedRuntime.make(WorkflowDependencies);

export const runWorkflowPromise = <A, E>(
	effect: Effect.Effect<A, E, Layer.Success<typeof WorkflowDependencies>>,
) =>
	WorkflowRuntime.runPromiseExit(effect).then((result) => {
		if (Exit.isFailure(result)) {
			const reason = result.cause.reasons[0];
			if (
				result.cause.reasons.length === 1 &&
				reason &&
				Cause.isDieReason(reason)
			)
				throw reason.defect;
			throw result;
		}

		return result.value;
	});
