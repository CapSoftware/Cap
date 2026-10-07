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
} from "@/lib/loom-import/jobs";
import { loomImportJobWorkflow } from "@/workflows/loom-import-job";

type ActionResult<T = Record<never, never>> =
	| ({ ok: true } & T)
	| { ok: false; error: string };

const GENERIC_ERROR = "Something went wrong. Please try again.";

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

	try {
		const { jobId } = await createLoomImportJob({
			userId: user.id,
			orgId,
			fileName: typeof fileName === "string" ? fileName : "",
			rows,
		});
		await start(loomImportJobWorkflow, [{ jobId }]);
		return { ok: true, jobId };
	} catch (error) {
		if (error instanceof LoomImportError)
			return { ok: false, error: error.message };
		console.error("[loom-import] Could not create import", error);
		return { ok: false, error: GENERIC_ERROR };
	}
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

	const started = await markLoomImportJobStarting(jobId);
	if (started) await start(loomImportJobWorkflow, [{ jobId }]);
	return { ok: true, started };
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
	if (retried > 0) await start(loomImportJobWorkflow, [{ jobId }]);
	return { ok: true, retried };
}
