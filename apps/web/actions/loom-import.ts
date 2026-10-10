"use server";

import { getCurrentUser } from "@cap/database/auth/session";
import { userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { start } from "workflow/api";
import {
	cancelLoomImportJob,
	createLoomImportJob,
	getLoomImportJobForUser,
	LoomImportError,
	markLoomImportJobStarting,
	resetFailedLoomImportItems,
	revertLoomImportJobStart,
} from "@/lib/loom-import/jobs";
import { loomImportJobWorkflow } from "@/workflows/loom-import-job";

type ActionResult<T = Record<never, never>> =
	| ({ ok: true } & T)
	| { ok: false; error: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";

async function startJobWorkflow(jobId: string) {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			await start(loomImportJobWorkflow, [{ jobId }]);
			return true;
		} catch (error) {
			console.error("[loom-import] Could not start import workflow", {
				jobId,
				attempt,
				error,
			});
		}
	}
	return false;
}

export async function createLoomImportJobAction({
	orgId,
	fileName,
	rows,
}: {
	orgId: Organisation.OrganisationId;
	fileName: string;
	rows: unknown;
}): Promise<ActionResult<{ jobId: string }>> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Please sign in again." };

	let jobId: string;
	try {
		({ jobId } = await createLoomImportJob({
			userId: user.id,
			orgId,
			fileName: typeof fileName === "string" ? fileName : "",
			rows,
		}));
	} catch (error) {
		if (error instanceof LoomImportError)
			return { ok: false, error: error.message };
		console.error("[loom-import] Could not create import", error);
		return { ok: false, error: GENERIC_ERROR };
	}

	await startJobWorkflow(jobId);
	return { ok: true, jobId };
}

export async function startLoomImportJobAction(
	jobId: string,
): Promise<ActionResult<{ started: boolean }>> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Please sign in again." };
	const found = await getLoomImportJobForUser(jobId, user.id);
	if (!found) return { ok: false, error: "This import doesn't exist." };
	if (found.job.createdById !== user.id) {
		return {
			ok: false,
			error: "Only the person who uploaded this CSV can start it.",
		};
	}
	if (!userIsPro(user)) {
		return { ok: false, error: "Importing from Loom needs Cap Pro." };
	}

	if (!(await markLoomImportJobStarting(jobId))) {
		return { ok: true, started: false };
	}
	if (!(await startJobWorkflow(jobId))) {
		await revertLoomImportJobStart(jobId);
		return { ok: false, error: "The import couldn't start. Please try again." };
	}
	return { ok: true, started: true };
}

export async function cancelLoomImportJobAction(
	jobId: string,
): Promise<ActionResult> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Please sign in again." };
	const found = await getLoomImportJobForUser(jobId, user.id);
	if (!found) return { ok: false, error: "This import doesn't exist." };
	await cancelLoomImportJob(jobId);
	return { ok: true };
}

export async function retryLoomImportJobAction(
	jobId: string,
): Promise<ActionResult<{ retried: number }>> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Please sign in again." };
	const found = await getLoomImportJobForUser(jobId, user.id);
	if (!found) return { ok: false, error: "This import doesn't exist." };
	if (
		found.job.status === "cancelled" ||
		found.job.status === "awaiting_upgrade"
	) {
		return { ok: false, error: "This import can't be retried." };
	}
	const retried = await resetFailedLoomImportItems(jobId);
	if (retried > 0) await startJobWorkflow(jobId);
	return { ok: true, retried };
}
