import { db } from "@cap/database";
import { meetingNotesTrialUses } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, asc, eq } from "drizzle-orm";

export const MEETING_NOTES_TRIAL_MEETINGS = 3;

export type TrialClaim = "claimed" | "already_claimed" | "exhausted";

const userKey = (userId: string) => userId as User.UserId;

async function claimedMeetings(userId: string): Promise<string[]> {
	const rows = await db()
		.select({ meetingId: meetingNotesTrialUses.meetingId })
		.from(meetingNotesTrialUses)
		.where(eq(meetingNotesTrialUses.userId, userKey(userId)))
		.orderBy(
			asc(meetingNotesTrialUses.createdAt),
			asc(meetingNotesTrialUses.meetingId),
		);
	return rows.map((row) => row.meetingId);
}

export async function trialRemaining(
	userId: string,
	limit = MEETING_NOTES_TRIAL_MEETINGS,
): Promise<number> {
	if (limit <= 0) return 0;
	const claimed = await claimedMeetings(userId);
	return Math.max(0, limit - claimed.length);
}

export async function hasTrialMeeting(
	userId: string,
	meetingId: string,
): Promise<boolean> {
	const rows = await db()
		.select({ meetingId: meetingNotesTrialUses.meetingId })
		.from(meetingNotesTrialUses)
		.where(
			and(
				eq(meetingNotesTrialUses.userId, userKey(userId)),
				eq(meetingNotesTrialUses.meetingId, meetingId),
			),
		)
		.limit(1);
	return rows.length > 0;
}

// Two meetings finishing at once can both insert; the earliest rows win and a
// late one is removed again, so nobody gets a fourth free meeting.
export async function claimTrialMeeting(
	userId: string,
	meetingId: string,
	limit = MEETING_NOTES_TRIAL_MEETINGS,
): Promise<TrialClaim> {
	const before = await claimedMeetings(userId);
	if (before.includes(meetingId)) return "already_claimed";
	if (before.length >= limit) return "exhausted";
	await db()
		.insert(meetingNotesTrialUses)
		.values({ userId: userKey(userId), meetingId })
		.onDuplicateKeyUpdate({ set: { meetingId } });
	const after = await claimedMeetings(userId);
	if (after.slice(0, limit).includes(meetingId)) return "claimed";
	await releaseTrialMeeting(userId, meetingId);
	return "exhausted";
}

export async function releaseTrialMeeting(
	userId: string,
	meetingId: string,
): Promise<void> {
	await db()
		.delete(meetingNotesTrialUses)
		.where(
			and(
				eq(meetingNotesTrialUses.userId, userKey(userId)),
				eq(meetingNotesTrialUses.meetingId, meetingId),
			),
		);
}
