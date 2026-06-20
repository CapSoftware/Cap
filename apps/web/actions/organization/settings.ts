"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	isAiGenerationLanguage,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { normalizePlaybackSpeed } from "@/lib/playback-speed";
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
	aiGenerationLanguage?: AiGenerationLanguage;
	defaultPlaybackSpeed?: number;
};

const proOrganizationSettingKeys = [
	"disableSummary",
	"disableChapters",
	"disableTranscript",
	"hideShareableLinkCapLogo",
	"shareableLinkUseOrganizationIcon",
	"aiGenerationLanguage",
] as const satisfies readonly (keyof OrganizationSettingsInput)[];

const defaultProOrganizationSettings = {
	disableSummary: false,
	disableChapters: false,
	disableTranscript: false,
	hideShareableLinkCapLogo: false,
	shareableLinkUseOrganizationIcon: false,
	aiGenerationLanguage: AI_GENERATION_LANGUAGE_AUTO,
} as const satisfies Pick<
	Required<OrganizationSettingsInput>,
	(typeof proOrganizationSettingKeys)[number]
>;

const preserveProSettings = (
	submittedSettings: OrganizationSettingsInput,
	existingSettings: OrganizationSettingsInput | null | undefined,
) => ({
	...submittedSettings,
	...Object.fromEntries(
		proOrganizationSettingKeys.map((key) => [
			key,
			existingSettings?.[key] ?? defaultProOrganizationSettings[key],
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

	if (
		settings.aiGenerationLanguage !== undefined &&
		!isAiGenerationLanguage(settings.aiGenerationLanguage)
	) {
		throw new Error("Unsupported AI generation language");
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

	const sanitizedSettings =
		settings.defaultPlaybackSpeed !== undefined
			? {
					...settings,
					defaultPlaybackSpeed: normalizePlaybackSpeed(
						settings.defaultPlaybackSpeed,
					),
				}
			: settings;

	const nextSettings = userIsPro(user)
		? sanitizedSettings
		: preserveProSettings(sanitizedSettings, organization.settings);

	await db()
		.update(organizations)
		.set({ settings: nextSettings })
		.where(eq(organizations.id, user.activeOrganizationId));

	revalidatePath("/dashboard/caps");
	revalidatePath("/dashboard/settings/organization");
	revalidatePath("/dashboard/settings/organization/preferences");

	return { success: true };
}
