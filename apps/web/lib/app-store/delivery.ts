import {
	type ActionResult,
	type CapEventType,
	type ConnectionPermission,
	type EventRequest,
	type LifecycleRequest,
	parseActionResult,
} from "@cap/app-store";
import { db } from "@cap/database";
import { appStoreInstallations } from "@cap/database/schema";
import type { User, Video } from "@cap/web-domain";
import { and, eq, or, sql } from "drizzle-orm";
import {
	WEBHOOK_DISABLE_AFTER_FAILURES,
	WEBHOOK_DISABLE_AFTER_MS,
} from "@/lib/developer-webhook-events";
import { memberMayInstallConnections, userOrganizations } from "./access";
import { getCatalogApp } from "./catalog";
import { type ConnectionResult, sendConnectionRequest } from "./connection";
import {
	AppStoreError,
	eventIsGranted,
	type InstallationRow,
	installationRef,
	readInstallationSettings,
} from "./installations";
import {
	buildCapPayload,
	type CapRecord,
	loadCapRecord,
	loadCommentPayload,
} from "./payload";

export const DISABLED_BY_FAILURES = "delivery_failures";

export type DeliveryOutcome = "delivered" | "retry" | "dropped";

export type AppStoreDeliveryJob =
	| {
			kind: "event";
			installationId: string;
			eventId: string;
			type: CapEventType;
			videoId: string;
			commentId?: string;
			createdAt: string;
	  }
	| {
			kind: "lifecycle";
			installationId: string;
			type: "installed" | "settings.updated";
	  };

const appRef = (row: InstallationRow) => ({
	id: row.appId,
	version: getCatalogApp(row.appId)?.version ?? row.appVersion,
});

async function loadRow(installationId: string) {
	const [row] = await db()
		.select()
		.from(appStoreInstallations)
		.where(eq(appStoreInstallations.id, installationId))
		.limit(1);
	return row ?? null;
}

export async function capVisibleToInstallation(
	row: InstallationRow,
	record: CapRecord,
): Promise<boolean> {
	if (row.scope === "organization") {
		return !!row.organizationId && record.video.orgId === row.organizationId;
	}
	if (record.video.ownerId !== row.userId || !row.userId) return false;
	if (!record.video.orgId) return true;
	const organizations = await userOrganizations(row.userId as User.UserId);
	return memberMayInstallConnections(
		organizations.find((org) => org.id === record.video.orgId),
	);
}

const shouldRetry = (result: ConnectionResult) =>
	!result.ok &&
	(result.status === null ||
		result.status === 408 ||
		result.status === 429 ||
		result.status >= 500 ||
		result.errorCode === "redirect");

export async function recordConnectionResult(
	installationId: string,
	result: ConnectionResult,
	now: Date = new Date(),
) {
	await db().transaction(async (tx) => {
		const [row] = await tx
			.select({
				consecutiveFailures: appStoreInstallations.consecutiveFailures,
				failingSince: appStoreInstallations.failingSince,
				status: appStoreInstallations.status,
			})
			.from(appStoreInstallations)
			.where(eq(appStoreInstallations.id, installationId))
			.for("update");
		if (!row) return;
		const lastDeliveryStatus = result.ok
			? String(result.status)
			: (result.status?.toString() ?? result.errorCode);
		if (result.ok) {
			await tx
				.update(appStoreInstallations)
				.set({
					consecutiveFailures: 0,
					failingSince: null,
					lastDeliveryAt: now,
					lastDeliveryStatus,
				})
				.where(eq(appStoreInstallations.id, installationId));
			return;
		}
		const failures = row.consecutiveFailures + 1;
		const failingSince = row.failingSince ?? now;
		const disable =
			row.status === "active" &&
			failures >= WEBHOOK_DISABLE_AFTER_FAILURES &&
			now.getTime() - failingSince.getTime() >= WEBHOOK_DISABLE_AFTER_MS;
		await tx
			.update(appStoreInstallations)
			.set({
				consecutiveFailures: sql`${appStoreInstallations.consecutiveFailures} + 1`,
				failingSince,
				lastDeliveryAt: now,
				lastDeliveryStatus,
				...(disable
					? {
							status: "disabled" as const,
							disabledReason: DISABLED_BY_FAILURES,
						}
					: {}),
			})
			.where(eq(appStoreInstallations.id, installationId));
	});
}

export async function deliverAppStoreJob(
	job: AppStoreDeliveryJob,
): Promise<DeliveryOutcome> {
	const row = await loadRow(job.installationId);
	if (!row || row.status !== "active") return "dropped";
	const app = getCatalogApp(row.appId);
	if (!app?.connection) return "dropped";
	const settings = await readInstallationSettings(row);

	let request: EventRequest | LifecycleRequest;
	if (job.kind === "lifecycle") {
		request = {
			kind: "lifecycle",
			type: job.type,
			app: appRef(row),
			installation: installationRef(row),
			settings,
		};
	} else {
		if (!eventIsGranted(row, job.type)) return "dropped";
		const record = await loadCapRecord(job.videoId as Video.VideoId);
		if (!record || !(await capVisibleToInstallation(row, record))) {
			return "dropped";
		}
		const permissions = row.grantedPermissions as ConnectionPermission[];
		const comment = job.commentId
			? await loadCommentPayload(job.commentId)
			: undefined;
		if (job.commentId && !comment) return "dropped";
		request = {
			kind: "event",
			id: job.eventId,
			type: job.type,
			createdAt: job.createdAt,
			app: appRef(row),
			installation: installationRef(row),
			settings,
			data: {
				cap: await buildCapPayload(record, permissions),
				...(comment ? { comment } : {}),
			},
		};
	}

	const result = await sendConnectionRequest(
		{ appId: row.appId, url: app.connection.url },
		request,
		{ requestId: job.kind === "event" ? job.eventId : undefined },
	);
	await recordConnectionResult(row.id, result);
	if (result.ok) return "delivered";
	return shouldRetry(result) ? "retry" : "dropped";
}

export async function sendUninstalled(
	row: InstallationRow,
	settings: Awaited<ReturnType<typeof readInstallationSettings>>,
) {
	const app = getCatalogApp(row.appId);
	if (!app?.connection) return;
	await sendConnectionRequest(
		{ appId: row.appId, url: app.connection.url },
		{
			kind: "lifecycle",
			type: "uninstalled",
			app: appRef(row),
			installation: installationRef(row),
			settings,
		},
	).catch(() => undefined);
}

export type CapAction = {
	installationId: string;
	appId: string;
	appName: string;
	iconUrl: string;
	actionId: string;
	title: string;
	scope: "user" | "organization";
};

async function actionRowsForCap(userId: User.UserId, record: CapRecord) {
	const organizations = await userOrganizations(userId);
	const capOrganization = organizations.find(
		(org) => org.id === record.video.orgId,
	);
	// Actions send the Cap's details to another service, so only its owner can
	// run them. Organization membership alone does not grant access to a
	// private Cap.
	if (record.video.ownerId !== userId) return [];

	const scopes = [
		and(
			eq(appStoreInstallations.scope, "user"),
			eq(appStoreInstallations.userId, userId),
		),
	];
	if (capOrganization) {
		scopes.push(
			and(
				eq(appStoreInstallations.scope, "organization"),
				eq(appStoreInstallations.organizationId, capOrganization.id),
			),
		);
	}
	const rows = await db()
		.select()
		.from(appStoreInstallations)
		.where(and(eq(appStoreInstallations.status, "active"), or(...scopes)));
	return rows.filter((row) => {
		if (row.scope === "user") {
			return (
				row.userId === userId && memberMayInstallConnections(capOrganization)
			);
		}
		return !!capOrganization && row.organizationId === capOrganization.id;
	});
}

export async function listCapActions(
	userId: User.UserId,
	videoId: Video.VideoId,
): Promise<CapAction[]> {
	const record = await loadCapRecord(videoId);
	if (!record) return [];
	const rows = await actionRowsForCap(userId, record);
	const actions: CapAction[] = [];
	for (const row of rows) {
		const app = getCatalogApp(row.appId);
		for (const action of app?.connection?.actions ?? []) {
			if (!app) continue;
			actions.push({
				installationId: row.id,
				appId: app.id,
				appName: app.name,
				iconUrl: app.icon.url,
				actionId: action.id,
				title: action.title,
				scope: row.scope,
			});
		}
	}
	return actions.sort((a, b) => a.title.localeCompare(b.title));
}

export async function runCapAction(input: {
	userId: User.UserId;
	userName: string | null;
	installationId: string;
	actionId: string;
	videoId: Video.VideoId;
}): Promise<ActionResult> {
	const record = await loadCapRecord(input.videoId);
	if (!record) throw new AppStoreError("not_found", "This Cap was not found");
	const rows = await actionRowsForCap(input.userId, record);
	const row = rows.find((candidate) => candidate.id === input.installationId);
	if (!row) throw new AppStoreError("not_found", "This app is not installed");
	const app = getCatalogApp(row.appId);
	const action = app?.connection?.actions.find(
		(candidate) => candidate.id === input.actionId,
	);
	if (!app?.connection || !action) {
		throw new AppStoreError("not_found", "This action is not available");
	}

	const result = await sendConnectionRequest(
		{ appId: app.id, url: app.connection.url },
		{
			kind: "action",
			action: action.id,
			app: appRef(row),
			installation: installationRef(row),
			settings: await readInstallationSettings(row),
			user: { id: input.userId, name: input.userName },
			data: {
				cap: await buildCapPayload(
					record,
					row.grantedPermissions as ConnectionPermission[],
				),
			},
		},
		{ readBody: true },
	);
	if (!result.ok) {
		throw new AppStoreError(
			"unavailable",
			result.errorCode === "timeout"
				? `${app.name} took too long to respond`
				: `${app.name} could not complete this action`,
		);
	}
	let parsed: ActionResult | null = null;
	try {
		parsed = parseActionResult(JSON.parse(result.body ?? ""));
	} catch {
		parsed = null;
	}
	if (!parsed) {
		throw new AppStoreError(
			"unavailable",
			`${app.name} sent a response Cap could not read`,
		);
	}
	return parsed;
}
