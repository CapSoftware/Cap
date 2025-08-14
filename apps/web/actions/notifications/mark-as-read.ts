"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { notifications } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export const markAsRead = async (notificationId?: string) => {
	const currentUser = await getCurrentUser();
	if (!currentUser) {
		throw new Error("User not found");
	}

	try {
		const now = new Date();
		if (notificationId) {
			await db()
				.update(notifications)
				.set({ readAt: now })
				.where(eq(notifications.id, notificationId));
		} else {
			await db()
				.update(notifications)
				.set({ readAt: now })
				.where(eq(notifications.recipientId, currentUser.id));
		}
	} catch (error) {
		console.log(error);
		throw new Error("Error marking notification(s) as read");
	}

	revalidatePath("/dashboard");
};
