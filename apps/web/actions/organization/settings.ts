"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "./authorization";

type OrganizationSettingsInput = {
	disableSummary?: boolean;
	disableCaptions?: boolean;
	disableChapters?: boolean;
	disableReactions?: boolean;
	disableTranscript?: boolean;
	disableComments?: boolean;
	hideShareableLinkCapLogo?: boolean;
	shareableLinkUseOrganizationIcon?: boolean;
};

const proOrganizationSettingKeys = [
	"disableSummary",
	"disableChapters",
	"disableTranscript",
	"hideShareableLinkCapLogo",
	"shareableLinkUseOrganizationIcon",
] as const satisfies readonly (keyof OrganizationSettingsInput)[];

const preserveProSettings = (
	submittedSettings: OrganizationSettingsInput,
	existingSettings: OrganizationSettingsInput | null | undefined,
) => ({
	...submittedSettings,
	...Object.fromEntries(
		proOrganizationSettingKeys.map((key) => [
			key,
			existingSettings?.[key] ?? false,
		]),
	),
});

export async function updateOrganizationSettings(
	settings: OrganizationSettingsInput,
) {
	const user = await getCurrentUser();

	if (!user) {
		throw new Error("Unauthorized");
	}

	if (!settings) {
		throw new Error("Settings are required");
	}

	if (!user.activeOrganizationId) {
		throw new Error("Organization not found");
	}

	const [organization] = await db()
		.select()
		.from(organizations)
		.where(eq(organizations.id, user.activeOrganizationId));

	if (!organization) {
		throw new Error("Organization not found");
	}

	await requireOrganizationSettingsManager(user.id, user.activeOrganizationId);

	const nextSettings = userIsPro(user)
		? settings
		: preserveProSettings(settings, organization.settings);

	await db()
		.update(organizations)
		.set({ settings: nextSettings })
		.where(eq(organizations.id, user.activeOrganizationId));

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");

	return { success: true };
}
