import { serverEnv } from "@cap/env";
import type { User } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { db } from "./index.ts";
import { users } from "./schema.ts";

export type FirstCapEmailMarker = NonNullable<
	NonNullable<(typeof users.$inferSelect)["preferences"]>["firstCapEmail"]
>;

// Recordings are hard-deleted, so "is this the owner's only recording" says
// nothing about whether the email already went out. The marker on the user row
// is the only record that survives a deletion.
export async function updateFirstCapEmailMarker(
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

// Called from the shared delete service, which workflow bundles also load, so
// this goes to the provider over fetch instead of importing the email SDK.
export async function cancelScheduledFirstCapEmail(emailId: string) {
	const apiKey = serverEnv().RESEND_API_KEY;
	if (!apiKey) return false;

	const response = await fetch(
		`https://api.resend.com/emails/${encodeURIComponent(emailId)}/cancel`,
		{ method: "POST", headers: { Authorization: `Bearer ${apiKey}` } },
	);
	if (!response.ok)
		console.error(
			`[email] Could not cancel the scheduled first Cap email: ${response.status}`,
		);
	return response.ok;
}

export async function cancelFirstCapEmail(
	userId: User.UserId,
	videoId: string,
) {
	const [row] = await db()
		.select({ preferences: users.preferences })
		.from(users)
		.where(eq(users.id, userId))
		.limit(1);
	const marker = row?.preferences?.firstCapEmail;
	if (marker?.videoId !== videoId || Date.now() >= marker.sendAt) return false;

	if (marker.emailId && !(await cancelScheduledFirstCapEmail(marker.emailId)))
		return false;

	return updateFirstCapEmailMarker(userId, (current) =>
		current?.videoId === videoId ? null : undefined,
	);
}
