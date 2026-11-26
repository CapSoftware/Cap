import { db } from "@cap/database";
import { meetingAudioUsage } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { and, eq, sql } from "drizzle-orm";

// Past this the transcribe request goes on without the database's answer, and
// the per-instance daily window decides instead.
export const MEETING_AUDIO_USAGE_TIMEOUT_MS = 1_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DailyAudioDecision =
	| { allowed: true }
	| { allowed: false; retryAfterSeconds: number }
	| { allowed: undefined };

export function audioUsageDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

export function secondsUntilNextDay(now: Date): number {
	const next = Math.floor(now.getTime() / DAY_MS + 1) * DAY_MS;
	return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}

function affectedRows(result: unknown): number {
	const item = Array.isArray(result) ? result[0] : result;
	if (!item || typeof item !== "object" || !("affectedRows" in item)) return 0;
	return typeof item.affectedRows === "number" ? item.affectedRows : 0;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("audio usage timeout")), ms);
	});
	return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

// Adds `units` to the user's count for the day only when the total stays within
// `limit`, in one statement, so concurrent requests on any instance can never
// pass the cap together. The day's row is created on its first clip.
async function charge(
	userId: string,
	day: string,
	units: number,
	limit: number,
): Promise<boolean> {
	const row = and(
		eq(meetingAudioUsage.userId, userId as User.UserId),
		eq(meetingAudioUsage.day, day),
	);
	const add = () =>
		db()
			.update(meetingAudioUsage)
			.set({ units: sql`${meetingAudioUsage.units} + ${units}` })
			.where(and(row, sql`${meetingAudioUsage.units} + ${units} <= ${limit}`));

	if (affectedRows(await add()) > 0) return true;
	await db()
		.insert(meetingAudioUsage)
		.ignore()
		.values({ userId: userId as User.UserId, day, units: 0 });
	return affectedRows(await add()) > 0;
}

export async function consumeDailyAudioUnits(
	userId: string,
	units: number,
	limit: number,
	now = new Date(),
): Promise<DailyAudioDecision> {
	if (units > limit)
		return { allowed: false, retryAfterSeconds: secondsUntilNextDay(now) };
	try {
		const allowed = await withTimeout(
			charge(userId, audioUsageDay(now), units, limit),
			MEETING_AUDIO_USAGE_TIMEOUT_MS,
		);
		return allowed
			? { allowed: true }
			: { allowed: false, retryAfterSeconds: secondsUntilNextDay(now) };
	} catch (error) {
		console.error(
			"[meetings] audio usage unavailable",
			error instanceof Error ? error.name : "UnknownError",
		);
		return { allowed: undefined };
	}
}
