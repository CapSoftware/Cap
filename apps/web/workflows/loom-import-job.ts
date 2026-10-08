import { sleep } from "workflow";
import { dispatchLoomImportJob } from "@/lib/loom-import/dispatch";
import {
	prepareLoomImportJob,
	resolveLoomImportJob,
} from "@/lib/loom-import/jobs";

interface LoomImportJobPayload {
	jobId: string;
}

const RESOLVE_PATIENCE = 6;
const RESOLVE_MAX_PASSES = 60;

async function resolveLoomImportJobStep(jobId: string, giveUp: boolean) {
	"use step";

	return resolveLoomImportJob(jobId, { giveUp });
}

async function prepareLoomImportJobStep(jobId: string) {
	"use step";

	return prepareLoomImportJob(jobId);
}

async function dispatchLoomImportJobStep(jobId: string) {
	"use step";

	return dispatchLoomImportJob(jobId);
}

export async function loomImportJobWorkflow({ jobId }: LoomImportJobPayload) {
	"use workflow";

	let stalled = 0;
	let previous = Number.POSITIVE_INFINITY;
	for (let pass = 0; pass < RESOLVE_MAX_PASSES; pass++) {
		const { waiting } = await resolveLoomImportJobStep(jobId, false);
		if (waiting === 0) break;
		stalled = waiting < previous ? 0 : stalled + 1;
		previous = waiting;
		if (stalled >= RESOLVE_PATIENCE || pass === RESOLVE_MAX_PASSES - 1) {
			await resolveLoomImportJobStep(jobId, true);
			break;
		}
		await sleep(`${Math.min(300, 15 * 2 ** stalled)}s`);
	}
	const status = await prepareLoomImportJobStep(jobId);
	if (status !== "importing") return { jobId, status };
	const dispatched = await dispatchLoomImportJobStep(jobId);
	return {
		jobId,
		status: dispatched.completed ? "completed" : "importing",
		started: dispatched.started,
	};
}
