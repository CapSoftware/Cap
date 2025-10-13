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
import type { NextRequest } from "next/server";
import { uploadOrganizationIcon } from "@/actions/organization/upload-organization-icon";

export async function POST(request: NextRequest) {
	const user = await getCurrentUser();
	const formData = await request.formData();
	const organizationName = String(formData.get("organizationName") || "");
	const organizationIcon = (formData.get("icon") as FormDataEntryValue) || null;

	if (!user) {
		console.error("User not found");
		return Response.json({ error: true }, { status: 401 });
	}

	const organizationId = Organisation.OrganisationId.make(nanoId());

	await db().insert(organizations).values({
		id: organizationId,
		ownerId: user.id,
		name: organizationName,
	});

	if (organizationIcon) {
		await uploadOrganizationIcon(formData, organizationId);
	}

	await db().insert(organizationMembers).values({
		id: nanoId(),
		userId: user.id,
		role: "owner",
		organizationId,
	});

	await db()
		.update(users)
		.set({
			activeOrganizationId: organizationId,
			onboardingSteps: {
				welcome: true,
				organizationSetup: true,
			},
		})
		.where(eq(users.id, user.id));

	revalidatePath("/onboarding", "layout");

	return Response.json({ success: true }, { status: 200 });
}
