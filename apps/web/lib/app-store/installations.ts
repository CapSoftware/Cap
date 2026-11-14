import {
	type CapEventType,
	type CatalogApp,
	type ConnectionPermission,
	EVENT_REQUIRED_PERMISSION,
	type InstallationRef,
	type InstallationSettings,
} from "@cap/app-store";
import { db } from "@cap/database";
import { decrypt, encrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import { appStoreInstallations } from "@cap/database/schema";
import type { Organisation, User } from "@cap/web-domain";
import { and, eq, inArray, or } from "drizzle-orm";
import {
	canManageOrganizationApps,
	memberMayInstallConnections,
	type UserOrganization,
	userOrganizations,
} from "./access";
import { getCatalogApp, isSupportedApiVersion } from "./catalog";
import {
	defaultSettings,
	type PublicSettings,
	parseStoredSettings,
	publicSettings,
	resolveSettings,
	type SettingsInput,
	type StoredSettings,
	storedSettings,
} from "./settings";

export type InstallationRow = typeof appStoreInstallations.$inferSelect;
export type InstallScope = "user" | "organization";

export type AppStoreErrorCode =
	| "not_found"
	| "forbidden"
	| "invalid"
	| "conflict"
	| "unavailable";

export class AppStoreError extends Error {
	constructor(
		readonly code: AppStoreErrorCode,
		message: string,
		readonly fieldErrors?: Record<string, string>,
	) {
		super(message);
		this.name = "AppStoreError";
	}
}

export type InstallationView = {
	id: string;
	appId: string;
	scope: InstallScope;
	organizationId: string | null;
	organizationName: string | null;
	appVersion: string;
	grantedPermissions: ConnectionPermission[];
	grantedEvents: CapEventType[];
	status: "active" | "disabled";
	disabledReason: string | null;
	needsReview: boolean;
	canManage: boolean;
	settings: PublicSettings;
	createdAt: string;
};

export const scopeKeyFor = (scope: InstallScope, ownerId: string): string =>
	`${scope === "user" ? "user" : "org"}:${ownerId}`;

export const requestedPermissions = (app: CatalogApp) =>
	[...(app.connection?.permissions ?? [])] as ConnectionPermission[];
export const requestedEvents = (app: CatalogApp) =>
	[...(app.connection?.events ?? [])] as CapEventType[];

export function needsReview(row: InstallationRow, app: CatalogApp) {
	const granted = new Set([...row.grantedPermissions, ...row.grantedEvents]);
	return [...requestedPermissions(app), ...requestedEvents(app)].some(
		(item) => !granted.has(item),
	);
}

export function eventIsGranted(
	row: Pick<InstallationRow, "grantedEvents" | "grantedPermissions">,
	type: CapEventType,
) {
	if (!row.grantedEvents.includes(type)) return false;
	const required = EVENT_REQUIRED_PERMISSION[type];
	return !required || row.grantedPermissions.includes(required);
}

export async function readStoredSettings(
	row: Pick<InstallationRow, "encryptedSettings">,
): Promise<StoredSettings> {
	if (!row.encryptedSettings) return { values: {}, secretKeys: [] };
	return parseStoredSettings(await decrypt(row.encryptedSettings));
}

export async function readInstallationSettings(
	row: Pick<InstallationRow, "encryptedSettings">,
): Promise<InstallationSettings> {
	return (await readStoredSettings(row)).values;
}

const encryptSettings = async (stored: StoredSettings) =>
	Object.keys(stored.values).length === 0
		? null
		: await encrypt(JSON.stringify(stored));

export function installationRef(row: InstallationRow): InstallationRef {
	return {
		id: row.id,
		scope: row.scope,
		organizationId: row.organizationId ?? null,
		installedByUserId: row.installedByUserId,
	};
}

function requireInstallableApp(appId: string): CatalogApp {
	const app = getCatalogApp(appId);
	if (!app) throw new AppStoreError("not_found", "This app is not available");
	if (!isSupportedApiVersion(app.apiVersion)) {
		throw new AppStoreError(
			"unavailable",
			"This app needs a newer version of Cap",
		);
	}
	if (app.builtin) {
		throw new AppStoreError(
			"invalid",
			"Set this app up from its page in the App Store",
		);
	}
	return app;
}

function canManageRow(
	row: InstallationRow,
	userId: User.UserId,
	organizations: UserOrganization[],
) {
	if (row.scope === "user") return row.userId === userId;
	return canManageOrganizationApps(
		organizations.find((org) => org.id === row.organizationId),
	);
}

async function toView(
	row: InstallationRow,
	userId: User.UserId,
	organizations: UserOrganization[],
): Promise<InstallationView | null> {
	const app = getCatalogApp(row.appId);
	if (!app) return null;
	const fields = app.connection?.settings ?? [];
	const settings =
		fields.length > 0
			? publicSettings(fields, await readStoredSettings(row))
			: { values: {}, secretsSet: [] };
	return {
		id: row.id,
		appId: row.appId,
		scope: row.scope,
		organizationId: row.organizationId ?? null,
		organizationName:
			organizations.find((org) => org.id === row.organizationId)?.name ?? null,
		appVersion: row.appVersion,
		grantedPermissions: row.grantedPermissions as ConnectionPermission[],
		grantedEvents: row.grantedEvents as CapEventType[],
		status: row.status,
		disabledReason: row.disabledReason ?? null,
		needsReview: needsReview(row, app),
		canManage: canManageRow(row, userId, organizations),
		settings,
		createdAt: row.createdAt.toISOString(),
	};
}

async function rowsVisibleTo(
	userId: User.UserId,
	organizations: UserOrganization[],
) {
	const organizationIds = organizations.map((org) => org.id);
	return db()
		.select()
		.from(appStoreInstallations)
		.where(
			organizationIds.length > 0
				? or(
						and(
							eq(appStoreInstallations.scope, "user"),
							eq(appStoreInstallations.userId, userId),
						),
						and(
							eq(appStoreInstallations.scope, "organization"),
							inArray(appStoreInstallations.organizationId, organizationIds),
						),
					)
				: and(
						eq(appStoreInstallations.scope, "user"),
						eq(appStoreInstallations.userId, userId),
					),
		);
}

export async function listInstallations(
	userId: User.UserId,
): Promise<InstallationView[]> {
	const organizations = await userOrganizations(userId);
	const rows = await rowsVisibleTo(userId, organizations);
	const views = await Promise.all(
		rows.map((row) => toView(row, userId, organizations)),
	);
	return views
		.filter((view): view is InstallationView => view !== null)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

async function loadManagedRow(userId: User.UserId, installationId: string) {
	const organizations = await userOrganizations(userId);
	const [row] = await db()
		.select()
		.from(appStoreInstallations)
		.where(eq(appStoreInstallations.id, installationId))
		.limit(1);
	if (!row) throw new AppStoreError("not_found", "This app is not installed");
	const visible =
		(row.scope === "user" && row.userId === userId) ||
		(row.scope === "organization" &&
			organizations.some((org) => org.id === row.organizationId));
	if (!visible)
		throw new AppStoreError("not_found", "This app is not installed");
	if (!canManageRow(row, userId, organizations)) {
		throw new AppStoreError(
			"forbidden",
			"Only owners and admins can change apps installed for the organization",
		);
	}
	return { row, organizations };
}

export type InstallInput = {
	appId: string;
	scope: InstallScope;
	organizationId?: string | null;
	settings?: SettingsInput;
	activeOrganizationId?: string | null;
};

export async function installApp(
	userId: User.UserId,
	input: InstallInput,
): Promise<{ view: InstallationView; row: InstallationRow }> {
	const app = requireInstallableApp(input.appId);
	const organizations = await userOrganizations(userId);

	let organizationId: Organisation.OrganisationId | null = null;
	if (input.scope === "organization") {
		const organization = organizations.find(
			(org) => org.id === input.organizationId,
		);
		if (!canManageOrganizationApps(organization)) {
			throw new AppStoreError(
				"forbidden",
				"Only owners and admins can install apps for the organization",
			);
		}
		organizationId = organization?.id ?? null;
	} else if (app.connection) {
		const active = organizations.find(
			(org) => org.id === input.activeOrganizationId,
		);
		if (!memberMayInstallConnections(active)) {
			throw new AppStoreError(
				"forbidden",
				"Your organization only lets owners and admins install apps that connect to other services",
			);
		}
	}

	const fields = app.connection?.settings ?? [];
	let settings: InstallationSettings = {};
	if (fields.length > 0) {
		const resolved = resolveSettings(fields, input.settings ?? {}, null);
		if (!resolved.ok) {
			throw new AppStoreError(
				"invalid",
				"Some settings need attention",
				resolved.errors,
			);
		}
		settings = { ...defaultSettings(fields), ...resolved.settings };
	}

	const ownerId = input.scope === "user" ? userId : (organizationId ?? "");
	const scopeKey = scopeKeyFor(input.scope, ownerId);
	const [existing] = await db()
		.select({ id: appStoreInstallations.id })
		.from(appStoreInstallations)
		.where(
			and(
				eq(appStoreInstallations.appId, app.id),
				eq(appStoreInstallations.scopeKey, scopeKey),
			),
		)
		.limit(1);
	if (existing) {
		throw new AppStoreError("conflict", `${app.name} is already installed`);
	}

	const id = nanoId();
	try {
		await db()
			.insert(appStoreInstallations)
			.values({
				id,
				appId: app.id,
				scope: input.scope,
				scopeKey,
				userId: input.scope === "user" ? userId : null,
				organizationId,
				installedByUserId: userId,
				appVersion: app.version,
				grantedPermissions: requestedPermissions(app),
				grantedEvents: requestedEvents(app),
				encryptedSettings: await encryptSettings(
					storedSettings(fields, settings, null),
				),
				status: "active",
			});
	} catch (error) {
		if (
			error instanceof Error &&
			/duplicate|ER_DUP_ENTRY/i.test(`${error.message} ${String(error.cause)}`)
		) {
			throw new AppStoreError("conflict", `${app.name} is already installed`);
		}
		throw error;
	}

	const [row] = await db()
		.select()
		.from(appStoreInstallations)
		.where(eq(appStoreInstallations.id, id))
		.limit(1);
	if (!row) throw new Error("Installation was not saved");
	const view = await toView(row, userId, organizations);
	if (!view) throw new Error("Installation has no catalog entry");
	return { view, row };
}

export type UpdateInput = {
	settings?: SettingsInput;
	acceptUpdate?: boolean;
	resume?: boolean;
};

export async function updateInstallation(
	userId: User.UserId,
	installationId: string,
	input: UpdateInput,
): Promise<{
	view: InstallationView;
	row: InstallationRow;
	settingsChanged: boolean;
}> {
	const { row, organizations } = await loadManagedRow(userId, installationId);
	const app = getCatalogApp(row.appId);
	if (!app) throw new AppStoreError("not_found", "This app is not available");

	const patch: Partial<typeof appStoreInstallations.$inferInsert> = {};
	let settingsChanged = false;
	const fields = app.connection?.settings ?? [];
	if (input.settings && fields.length > 0) {
		const previous = await readStoredSettings(row);
		const existing = previous.values;
		const resolved = resolveSettings(fields, input.settings, existing);
		if (!resolved.ok) {
			throw new AppStoreError(
				"invalid",
				"Some settings need attention",
				resolved.errors,
			);
		}
		settingsChanged =
			JSON.stringify(existing) !== JSON.stringify(resolved.settings);
		patch.encryptedSettings = await encryptSettings(
			storedSettings(fields, resolved.settings, previous),
		);
	}
	if (input.acceptUpdate) {
		patch.grantedPermissions = requestedPermissions(app);
		patch.grantedEvents = requestedEvents(app);
		patch.appVersion = app.version;
	}
	if (input.resume || (settingsChanged && row.status === "disabled")) {
		patch.status = "active";
		patch.disabledReason = null;
		patch.consecutiveFailures = 0;
		patch.failingSince = null;
	}

	if (Object.keys(patch).length > 0) {
		await db()
			.update(appStoreInstallations)
			.set(patch)
			.where(eq(appStoreInstallations.id, row.id));
	}
	const [updated] = await db()
		.select()
		.from(appStoreInstallations)
		.where(eq(appStoreInstallations.id, row.id))
		.limit(1);
	if (!updated)
		throw new AppStoreError("not_found", "This app is not installed");
	const view = await toView(updated, userId, organizations);
	if (!view) throw new AppStoreError("not_found", "This app is not available");
	return { view, row: updated, settingsChanged };
}

export async function uninstallApp(
	userId: User.UserId,
	installationId: string,
): Promise<{ row: InstallationRow; settings: InstallationSettings }> {
	const { row } = await loadManagedRow(userId, installationId);
	const settings = await readInstallationSettings(row).catch(() => ({}));
	await db()
		.delete(appStoreInstallations)
		.where(eq(appStoreInstallations.id, row.id));
	return { row, settings };
}
