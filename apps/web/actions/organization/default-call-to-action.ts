"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import { userIsPro } from "@cap/utils";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	type CallToActionErrors,
	type CallToActionInput,
	type ShareCallToAction,
	toStoredCallToAction,
	validateCallToAction,
} from "@/lib/share-call-to-action";
import { requireOrganizationSettingsManager } from "./authorization";

export type UpdateOrganizationCallToActionResult =
	| { success: true; callToAction: ShareCallToAction | null }
	| { success: false; errors: CallToActionErrors; upgradeRequired?: true };

const settingsObject = sql`CASE WHEN JSON_TYPE(${organizations.settings}) = 'OBJECT' THEN ${organizations.settings} ELSE JSON_OBJECT() END`;

export async function updateOrganizationCallToAction(
	organizationId: Organisation.OrganisationId,
	input: (CallToActionInput & { includeExisting?: boolean }) | null,
): Promise<UpdateOrganizationCallToActionResult> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");
	if (!organizationId) throw new Error("Missing organization");

	await requireOrganizationSettingsManager(user.id, organizationId);

	const activeOrganization = and(
		eq(organizations.id, organizationId),
		isNull(organizations.tombstoneAt),
	);

	if (input === null) {
		await db()
			.update(organizations)
			.set({
				settings: sql`JSON_REMOVE(${settingsObject}, '$.defaultCallToAction')`,
			})
			.where(activeOrganization);
		revalidatePath("/dashboard/settings/organization/preferences");
		return { success: true, callToAction: null };
	}

	if (!userIsPro(user)) {
		return { success: false, errors: {}, upgradeRequired: true };
	}

	const result = validateCallToAction(input);
	if (!result.ok) return { success: false, errors: result.errors };

	const stored = {
		...toStoredCallToAction(result.value),
		includeExisting: input.includeExisting === true,
	};
	const enabledAt = new Date().toISOString();

	await db()
		.update(organizations)
		.set({
			settings: sql`JSON_SET(${settingsObject}, '$.defaultCallToAction', JSON_SET(CAST(${JSON.stringify(stored)} AS JSON), '$.enabledAt', COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${organizations.settings}, '$.defaultCallToAction.enabledAt')), ${enabledAt})))`,
		})
		.where(activeOrganization);

	revalidatePath("/dashboard/settings/organization/preferences");
	return { success: true, callToAction: result.value };
}
