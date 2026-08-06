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
	effect: Effect.Effect<A, E, Layer.Layer.Success<typeof WorkflowDependencies>>,
) =>
	WorkflowRuntime.runPromiseExit(effect).then((result) => {
		if (Exit.isFailure(result)) {
			if (Cause.isDieType(result.cause)) throw result.cause.defect;
			throw result;
		}

		return result.value;
	});
