import { db } from "@cap/database";
import { cancelScheduledEmail, sendEmail } from "@cap/database/emails/config";
import { FirstShareableLink } from "@cap/database/emails/first-shareable-link";
import { users } from "@cap/database/schema";
import type { User } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";

const FIRST_CAP_EMAIL_DELAY_MS = 5 * 60 * 1000;

type FirstCapEmailMarker = NonNullable<
	NonNullable<(typeof users.$inferSelect)["preferences"]>["firstCapEmail"]
>;

// Recordings are hard-deleted, so "is this the owner's only recording" says
// nothing about whether the email already went out. The marker on the user row
// is the only record that survives a deletion.
async function updateMarker(
	userId: User.UserId,
	next: (
		current: FirstCapEmailMarker | undefined,
	) => FirstCapEmailMarker | null | undefined,
) {
	return db().transaction(async (tx) => {
		const [row] = await tx
			.select({ preferences: users.preferences })
			.from(users)
			.where(eq(users.id, userId))
			.for("update");
		if (!row) return false;

		const marker = next(row.preferences?.firstCapEmail);
		if (marker === undefined) return false;

		await tx
			.update(users)
			.set({
				preferences:
					marker === null
						? sql`JSON_REMOVE(COALESCE(${users.preferences}, JSON_OBJECT()), '$.firstCapEmail')`
						: sql`JSON_SET(COALESCE(${users.preferences}, JSON_OBJECT()), '$.firstCapEmail', CAST(${JSON.stringify(marker)} AS JSON))`,
			})
			.where(eq(users.id, userId));
		return true;
	});
}

export async function scheduleFirstCapEmail({
	userId,
	email,
	videoId,
	videoName,
	url,
}: {
	userId: User.UserId;
	email: string;
	videoId: string;
	videoName: string;
	url: string;
}) {
	const claimed = await updateMarker(userId, (current) =>
		current
			? undefined
			: { videoId, sendAt: Date.now() + FIRST_CAP_EMAIL_DELAY_MS },
	);
	if (!claimed) return false;

	const result = await sendEmail({
		email,
		subject: "You created your first Cap! 🥳",
		react: FirstShareableLink({ email, url, videoName }),
		marketing: true,
		scheduledAt: "in 5 min",
	});

	const emailId = result?.data?.id;
	if (!emailId) return true;

	const recorded = await updateMarker(userId, (current) =>
		current?.videoId === videoId ? { ...current, emailId } : undefined,
	);
	if (!recorded) await cancelScheduledEmail(emailId);
	return recorded;
}

export async function cancelFirstCapEmail(
	userId: User.UserId,
	videoId: string,
) {
	let emailId: string | undefined;
	const released = await updateMarker(userId, (current) => {
		if (current?.videoId !== videoId || Date.now() >= current.sendAt)
			return undefined;
		emailId = current.emailId;
		return null;
	});

	if (released && emailId) await cancelScheduledEmail(emailId);
	return released;
}
