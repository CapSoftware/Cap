import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users } from "@cap/database/schema";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	const { firstName, lastName } = await request.json();

	if (!user) {
		console.error("User not found");
		return Response.json({ error: true }, { status: 401 });
	}

	await db()
		.update(users)
		.set({
			onboardingSteps: {
				welcome: true,
			},
			name: firstName,
			lastName: lastName || "",
		})
		.where(eq(users.id, user.id));

	revalidatePath("/onboarding", "layout");

	return Response.json(
		{
			success: true,
		},
		{ status: 200 },
	);
}
