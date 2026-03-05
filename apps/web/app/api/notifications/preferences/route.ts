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
		pauseAnonViews: z.boolean().optional().default(false),
	}),
});

export const dynamic = "force-dynamic";

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

		const defaultNotifications = {
			notifications: {
				pauseComments: false,
				pauseReplies: false,
				pauseViews: false,
				pauseReactions: false,
				pauseAnonViews: false,
			},
		};

		const parsedData = PreferencesSchema.safeParse(
			userPreferences?.preferences ?? defaultNotifications,
		);

		return NextResponse.json(
			parsedData.success
				? parsedData.data.notifications
				: defaultNotifications.notifications,
			{ status: 200 },
		);
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
