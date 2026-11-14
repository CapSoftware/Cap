"use server";

import type { ActionResult } from "@cap/app-store";
import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizations } from "@cap/database/schema";
import type { Organisation, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { requireOrganizationSettingsManager } from "@/actions/organization/authorization";
import {
	type CapAction,
	listCapActions,
	runCapAction,
	sendUninstalled,
} from "@/lib/app-store/delivery";
import {
	announceInBackground,
	announceLifecycle,
} from "@/lib/app-store/events";
import {
	AppStoreError,
	type InstallationView,
	type InstallScope,
	installApp,
	uninstallApp,
	updateInstallation,
} from "@/lib/app-store/installations";
import type { SettingsInput } from "@/lib/app-store/settings";

export type AppStoreActionResult<T> =
	| { ok: true; value: T }
	| { ok: false; error: string; fieldErrors?: Record<string, string> };

async function run<T>(
	work: () => Promise<T>,
): Promise<AppStoreActionResult<T>> {
	try {
		return { ok: true, value: await work() };
	} catch (error) {
		if (error instanceof AppStoreError) {
			return {
				ok: false,
				error: error.message,
				fieldErrors: error.fieldErrors,
			};
		}
		console.error("[app-store] Action failed", error);
		return { ok: false, error: "Something went wrong. Try again." };
	}
}

async function requireUser() {
	const user = await getCurrentUser();
	if (!user) throw new AppStoreError("forbidden", "Sign in to manage apps");
	return user;
}

export async function installAppAction(input: {
	appId: string;
	scope: InstallScope;
	organizationId?: string | null;
	settings?: SettingsInput;
}): Promise<AppStoreActionResult<InstallationView>> {
	return run(async () => {
		const user = await requireUser();
		const { view, row } = await installApp(user.id, {
			...input,
			activeOrganizationId: user.activeOrganizationId,
		});
		announceLifecycle(row.id, "installed");
		revalidatePath("/dashboard/apps", "layout");
		return view;
	});
}

export async function updateInstallationAction(
	installationId: string,
	input: { settings?: SettingsInput; acceptUpdate?: boolean; resume?: boolean },
): Promise<AppStoreActionResult<InstallationView>> {
	return run(async () => {
		const user = await requireUser();
		const result = await updateInstallation(user.id, installationId, input);
		if (result.settingsChanged) {
			announceLifecycle(result.row.id, "settings.updated");
		}
		revalidatePath("/dashboard/apps", "layout");
		return result.view;
	});
}

export async function uninstallAppAction(
	installationId: string,
): Promise<AppStoreActionResult<null>> {
	return run(async () => {
		const user = await requireUser();
		const { row, settings } = await uninstallApp(user.id, installationId);
		announceInBackground(
			`uninstalled for ${row.id}`,
			sendUninstalled(row, settings),
		);
		revalidatePath("/dashboard/apps", "layout");
		return null;
	});
}

export async function listCapActionsAction(
	videoId: Video.VideoId,
): Promise<AppStoreActionResult<CapAction[]>> {
	return run(async () => {
		const user = await requireUser();
		return listCapActions(user.id, videoId);
	});
}

export async function runCapActionAction(input: {
	videoId: Video.VideoId;
	installationId: string;
	actionId: string;
}): Promise<AppStoreActionResult<ActionResult>> {
	return run(async () => {
		const user = await requireUser();
		return runCapAction({
			userId: user.id,
			userName: user.name ?? null,
			...input,
		});
	});
}

export async function setAppStoreAdminsOnlyAction(
	organizationId: Organisation.OrganisationId,
	adminsOnly: boolean,
): Promise<AppStoreActionResult<boolean>> {
	return run(async () => {
		const user = await requireUser();
		await requireOrganizationSettingsManager(user.id, organizationId).catch(
			() => {
				throw new AppStoreError(
					"forbidden",
					"Only owners and admins can change this setting",
				);
			},
		);
		await db()
			.update(organizations)
			.set({
				settings: sql`JSON_MERGE_PATCH(COALESCE(${organizations.settings}, JSON_OBJECT()), CAST(${JSON.stringify({ appStoreAdminsOnly: adminsOnly })} AS JSON))`,
			})
			.where(eq(organizations.id, organizationId));
		revalidatePath("/dashboard/apps", "layout");
		return adminsOnly;
	});
}
