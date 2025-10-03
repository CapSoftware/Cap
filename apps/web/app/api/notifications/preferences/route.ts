import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";

const PreferencesSchema = z.object({
	notifications: z.object({
		pauseComments: z.boolean(),
		pauseReplies: z.boolean(),
		pauseViews: z.boolean(),
		pauseReactions: z.boolean(),
	}),
});

export async function GET() {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		return NextResponse.json(
			{ error: "Unauthorized" },
			{
				status: 401,
			},
		);
	}
	try {
		const [userPreferences] = await db()
			.select({
				preferences: users.preferences,
			})
			.from(users)
			.where(eq(users.id, currentUser.id))
			.limit(1);

		const parsedData = PreferencesSchema.parse(userPreferences?.preferences);

		return NextResponse.json(parsedData.notifications, {
			status: 200,
		});
	} catch (error) {
		console.error("Error fetching user preferences:", error);
		return NextResponse.json(
			{ error: "Failed to fetch user preferences" },
			{
				status: 500,
			},
		);
	}
}
