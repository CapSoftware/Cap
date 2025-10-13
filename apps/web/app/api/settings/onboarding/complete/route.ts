import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";

export async function POST() {
	const user = await getCurrentUser();
	if (!user) {
		console.error("User not found");
		return Response.json({ error: true }, { status: 401 });
	}

	await db()
		.update(users)
		.set({
			onboardingSteps: {
				welcome: true,
				organizationSetup: true,
				customDomain: true,
				inviteTeam: true,
			},
		})
		.where(eq(users.id, user.id));

	return Response.json({ success: true }, { status: 200 });
}
