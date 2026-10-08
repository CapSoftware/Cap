export type LoomImportQueueJob = {
	id: string;
	creatorId: string;
	dispatchedAt: Date | null;
	startedAt: Date | null;
};

export type LoomImportQueueLoad = {
	jobs: Map<string, number>;
	creators: Map<string, number>;
};

function time(value: Date | null) {
	return value ? value.getTime() : Number.NEGATIVE_INFINITY;
}

function compareJobs(
	left: LoomImportQueueJob,
	right: LoomImportQueueJob,
	load: LoomImportQueueLoad,
) {
	return (
		(load.creators.get(left.creatorId) ?? 0) -
			(load.creators.get(right.creatorId) ?? 0) ||
		(load.jobs.get(left.id) ?? 0) - (load.jobs.get(right.id) ?? 0) ||
		time(left.dispatchedAt) - time(right.dispatchedAt) ||
		time(left.startedAt) - time(right.startedAt) ||
		left.id.localeCompare(right.id)
	);
}

export function pickLoomImportJob<Job extends LoomImportQueueJob>(
	jobs: Iterable<Job>,
	load: LoomImportQueueLoad,
	perJob: number,
): Job | null {
	let best: Job | null = null;
	for (const job of jobs) {
		if ((load.jobs.get(job.id) ?? 0) >= perJob) continue;
		if (!best || compareJobs(job, best, load) < 0) best = job;
	}
	return best;
}

export function addLoomImportLoad(
	load: LoomImportQueueLoad,
	job: Pick<LoomImportQueueJob, "id" | "creatorId">,
) {
	load.jobs.set(job.id, (load.jobs.get(job.id) ?? 0) + 1);
	load.creators.set(job.creatorId, (load.creators.get(job.creatorId) ?? 0) + 1);
}
