"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { autoModeSessions } from "@cap/database/schema";
import type { AutoMode } from "@cap/web-domain";
import { eq } from "drizzle-orm";

export async function updateAutoModeQuestionnaire(
	input: AutoMode.UpdateQuestionnaireInput,
): Promise<{ success: true } | { success: false; message: string }> {
	const user = await getCurrentUser();

	if (!user) {
		return { success: false, message: "Unauthorized" };
	}

	if (!input.sessionId) {
		return { success: false, message: "Session ID is required" };
	}

	const [session] = await db()
		.select()
		.from(autoModeSessions)
		.where(eq(autoModeSessions.id, input.sessionId));

	if (!session) {
		return { success: false, message: "Session not found" };
	}

	if (session.userId !== user.id) {
		return {
			success: false,
			message: "You don't have permission to update this session",
		};
	}

	const questionnaire = {
		targetUrl: input.questionnaire.targetUrl,
		recordingFocus: input.questionnaire.recordingFocus,
		keyActions: input.questionnaire.keyActions,
		narrationTone: input.questionnaire.narrationTone,
		durationPreference: input.questionnaire.durationPreference,
		additionalContext: input.questionnaire.additionalContext,
	};

	await db()
		.update(autoModeSessions)
		.set({
			questionnaire,
			targetUrl: input.questionnaire.targetUrl ?? null,
			status: "planning",
		})
		.where(eq(autoModeSessions.id, input.sessionId));

	return { success: true };
}

export async function getAutoModeSession(
	sessionId: AutoMode.AutoModeSessionId,
): Promise<
	| { success: true; session: typeof autoModeSessions.$inferSelect }
	| { success: false; message: string }
> {
	const user = await getCurrentUser();

	if (!user) {
		return { success: false, message: "Unauthorized" };
	}

	if (!sessionId) {
		return { success: false, message: "Session ID is required" };
	}

	const [session] = await db()
		.select()
		.from(autoModeSessions)
		.where(eq(autoModeSessions.id, sessionId));

	if (!session) {
		return { success: false, message: "Session not found" };
	}

	if (session.userId !== user.id) {
		return {
			success: false,
			message: "You don't have permission to access this session",
		};
	}

	return { success: true, session };
}
