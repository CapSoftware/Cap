import { db } from "@cap/database";
import { meetingNotesTrialUses } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, eq, isNotNull, isNull, lt, or, sql } from "drizzle-orm";

export const MEETING_NOTES_TRIAL_MEETINGS = 3;
// A free meeting may be rewritten and asked about, but not reused without end
// for other material under the same meeting id.
export const TRIAL_NOTES_RUNS_PER_MEETING = 3;
export const TRIAL_ASKS_PER_MEETING = 5;
// Longer than a notes request may run, so a pending claim older than this was
// abandoned (its instance died before releasing it).
export const TRIAL_PENDING_STALE_MS = 330_000;

export type TrialClaim =
	| "claimed"
	| "already_claimed"
	| "busy"
	| "exhausted"
	| "runs_exhausted";

const userKey = (userId: string) => userId as User.UserId;

const isDuplicateKey = (error: unknown): boolean => {
	const value = error as { code?: string; errno?: number; cause?: unknown };
	if (value?.code === "ER_DUP_ENTRY" || value?.errno === 1062) return true;
	return value?.cause !== undefined && isDuplicateKey(value.cause);
};

function affectedRows(result: unknown): number {
	const item = Array.isArray(result) ? result[0] : result;
	if (!item || typeof item !== "object" || !("affectedRows" in item)) return 0;
	return typeof item.affectedRows === "number" ? item.affectedRows : 0;
}

const rowFor = (userId: string, meetingId: string) =>
	and(
		eq(meetingNotesTrialUses.userId, userKey(userId)),
		eq(meetingNotesTrialUses.meetingId, meetingId),
	);

async function userClaims(userId: string) {
	return db()
		.select({
			meetingId: meetingNotesTrialUses.meetingId,
			slot: meetingNotesTrialUses.slot,
			notesRuns: meetingNotesTrialUses.notesRuns,
			completedAt: meetingNotesTrialUses.completedAt,
		})
		.from(meetingNotesTrialUses)
		.where(eq(meetingNotesTrialUses.userId, userKey(userId)));
}

export async function trialRemaining(
	userId: string,
	limit = MEETING_NOTES_TRIAL_MEETINGS,
): Promise<number> {
	if (limit <= 0) return 0;
	return Math.max(0, limit - (await userClaims(userId)).length);
}

// Another run of a meeting already written up free. Refused while the first
// run of that meeting is still pending, so a failure there cannot release a
// meeting another request finished.
async function rerunClaimed(
	userId: string,
	meetingId: string,
	now: Date,
): Promise<TrialClaim> {
	const stale = new Date(now.getTime() - TRIAL_PENDING_STALE_MS);
	const result = await db()
		.update(meetingNotesTrialUses)
		.set({
			notesRuns: sql`${meetingNotesTrialUses.notesRuns} + 1`,
			startedAt: now,
		})
		.where(
			and(
				rowFor(userId, meetingId),
				lt(meetingNotesTrialUses.notesRuns, TRIAL_NOTES_RUNS_PER_MEETING),
				or(
					isNotNull(meetingNotesTrialUses.completedAt),
					lt(meetingNotesTrialUses.startedAt, stale),
				),
			),
		);
	if (affectedRows(result) > 0) return "already_claimed";
	const [row] = await db()
		.select({ notesRuns: meetingNotesTrialUses.notesRuns })
		.from(meetingNotesTrialUses)
		.where(rowFor(userId, meetingId));
	if (!row) return "busy";
	return row.notesRuns >= TRIAL_NOTES_RUNS_PER_MEETING
		? "runs_exhausted"
		: "busy";
}

// Each free meeting takes one of the user's numbered slots; the unique
// (userId, slot) key makes two meetings racing for the last slot settle in
// the database, so nobody gets more than `limit`.
export async function claimTrialMeeting(
	userId: string,
	meetingId: string,
	limit = MEETING_NOTES_TRIAL_MEETINGS,
	now = new Date(),
): Promise<TrialClaim> {
	for (let attempt = 0; attempt <= limit; attempt++) {
		const claims = await userClaims(userId);
		if (claims.some((claim) => claim.meetingId === meetingId))
			return rerunClaimed(userId, meetingId, now);
		const taken = new Set(claims.map((claim) => claim.slot));
		const slot = Array.from({ length: limit }, (_, i) => i + 1).find(
			(candidate) => !taken.has(candidate),
		);
		if (slot === undefined) return "exhausted";
		try {
			await db()
				.insert(meetingNotesTrialUses)
				.values({
					userId: userKey(userId),
					meetingId,
					slot,
					notesRuns: 1,
					askRuns: 0,
					startedAt: now,
					createdAt: now,
				});
			return "claimed";
		} catch (error) {
			if (!isDuplicateKey(error)) throw error;
		}
	}
	return "exhausted";
}

export async function completeTrialMeeting(
	userId: string,
	meetingId: string,
	now = new Date(),
): Promise<void> {
	await db()
		.update(meetingNotesTrialUses)
		.set({ completedAt: now })
		.where(
			and(rowFor(userId, meetingId), isNull(meetingNotesTrialUses.completedAt)),
		);
}

// Gives a meeting back when its first write-up failed. A meeting that was
// written once stays claimed whatever happens to later runs.
export async function releaseTrialMeeting(
	userId: string,
	meetingId: string,
): Promise<void> {
	await db()
		.delete(meetingNotesTrialUses)
		.where(
			and(rowFor(userId, meetingId), isNull(meetingNotesTrialUses.completedAt)),
		);
}

export async function spendTrialAsk(
	userId: string,
	meetingId: string,
): Promise<boolean> {
	const result = await db()
		.update(meetingNotesTrialUses)
		.set({ askRuns: sql`${meetingNotesTrialUses.askRuns} + 1` })
		.where(
			and(
				rowFor(userId, meetingId),
				isNotNull(meetingNotesTrialUses.completedAt),
				lt(meetingNotesTrialUses.askRuns, TRIAL_ASKS_PER_MEETING),
			),
		);
	return affectedRows(result) > 0;
}
