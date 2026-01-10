"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import { autoModeSessions } from "@cap/database/schema";
import type { AutoMode, Organisation } from "@cap/web-domain";

export async function createAutoModeSession(
	input: AutoMode.CreateSessionInput,
): Promise<
	| { success: true; sessionId: AutoMode.AutoModeSessionId }
	| { success: false; message: string }
> {
	const user = await getCurrentUser();

	if (!user) {
		return { success: false, message: "Unauthorized" };
	}

	if (!input.prompt || input.prompt.trim().length === 0) {
		return { success: false, message: "Prompt is required" };
	}

	if (!input.orgId) {
		return { success: false, message: "Organization ID is required" };
	}

	const sessionId = nanoId() as AutoMode.AutoModeSessionId;

	await db()
		.insert(autoModeSessions)
		.values({
			id: sessionId,
			userId: user.id,
			orgId: input.orgId as Organisation.OrganisationId,
			status: "draft",
			prompt: input.prompt.trim(),
		});

	return { success: true, sessionId };
}
