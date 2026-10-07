import { dispatchLoomImportJob } from "@/lib/loom-import/dispatch";
import {
	prepareLoomImportJob,
	resolveLoomImportJob,
} from "@/lib/loom-import/jobs";

interface LoomImportJobPayload {
	jobId: string;
}

async function resolveLoomImportJobStep(jobId: string) {
	"use step";

	await resolveLoomImportJob(jobId);
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

	await resolveLoomImportJobStep(jobId);
	const status = await prepareLoomImportJobStep(jobId);
	if (status !== "importing") return { jobId, status };
	const dispatched = await dispatchLoomImportJobStep(jobId);
	return {
		jobId,
		status: dispatched.completed ? "completed" : "importing",
		started: dispatched.started,
	};
}
