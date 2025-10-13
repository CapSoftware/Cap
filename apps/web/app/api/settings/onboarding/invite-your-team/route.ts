import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { NextResponse } from "next/server";

export async function POST() {
	const user = await getCurrentUser();

	if (!user) {
		console.error("User not found");
		return NextResponse.json({ error: true }, { status: 401 });
	}

	try {
		await db()
			.update(users)
			.set({
				onboardingSteps: {
					welcome: true,
					organizationSetup: true,
					customDomain: true,
					inviteTeam: true,
				},
				onboarding_completed_at: new Date(),
			})
			.where(eq(users.id, user.id));

		revalidatePath("/onboarding", "layout");
		return NextResponse.json({ success: true }, { status: 200 });
	} catch (error) {
		console.error("Failed to update user onboarding steps", error);
		return NextResponse.json({ error: true }, { status: 500 });
	}
}
