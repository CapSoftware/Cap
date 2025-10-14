import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { nanoId } from "@cap/database/helpers";
import {
	organizationMembers,
	organizations,
	users,
} from "@cap/database/schema";
import { Organisation } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";
import { uploadOrganizationIcon } from "@/actions/organization/upload-organization-icon";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	const formData = await request.formData();
	const organizationName = String(formData.get("organizationName"));
	const organizationIcon = (formData.get("icon") as FormDataEntryValue) || null;

	if (!user) {
		console.error("User not found");
		return NextResponse.json({ error: true }, { status: 401 });
	}

	if (!organizationName || organizationName.length === 0) {
		console.error("Organization name is required");
		return NextResponse.json({ error: true }, { status: 400 });
	}

	const organizationId = Organisation.OrganisationId.make(nanoId());

	try {
		await db().transaction(async (tx) => {
			await tx.insert(organizations).values({
				id: organizationId,
				ownerId: user.id,
				name: organizationName,
			});

			await tx.insert(organizationMembers).values({
				id: nanoId(),
				userId: user.id,
				role: "owner",
				organizationId,
			});
			await tx
				.update(users)
				.set({
					activeOrganizationId: organizationId,
					onboardingSteps: {
						...user.onboardingSteps,
						organizationSetup: true,
					},
				})
				.where(eq(users.id, user.id));
		});

		if (organizationIcon) {
			await uploadOrganizationIcon(formData, organizationId);
		}

		revalidatePath("/onboarding", "layout");
		return NextResponse.json({ success: true }, { status: 200 });
	} catch (error) {
		console.error("Failed to update user onboarding steps", error);
		return NextResponse.json({ error: true }, { status: 500 });
	}
}
