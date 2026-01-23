"use server";

import { db } from "@inflight/database";
import { getCurrentUser } from "@inflight/database/auth/session";
import { users } from "@inflight/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const updatePreferences = async ({
	notifications,
}: {
	notifications: {
		pauseComments: boolean;
		pauseReplies: boolean;
		pauseViews: boolean;
		pauseReactions: boolean;
	};
}) => {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("User not found");
	}

	try {
		await db()
			.update(users)
			.set({
				preferences: {
					notifications,
				},
			})
			.where(eq(users.id, currentUser.id));
		revalidatePath("/dashboard");
	} catch (error) {
		console.log(error);
		throw new Error("Error updating preferences");
	}
};
