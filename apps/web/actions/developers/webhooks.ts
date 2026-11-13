"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { developerApps } from "@cap/database/schema";
import { and, eq, isNull } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import {
	DEVELOPER_CONSOLE_RATE_MESSAGE,
	developerConsoleRequestLimited,
} from "@/lib/developer-app-limits";
import {
	createWebhookEndpointInput,
	updateWebhookEndpointInput,
} from "@/lib/developer-webhook-input";
import {
	createWebhookEndpoint,
	deleteWebhookEndpoint,
	rotateWebhookEndpointSecret,
	sendWebhookTestEvent,
	serializeWebhookEndpoint,
	serializeWebhookTestResult,
	updateWebhookEndpoint,
	type WebhookFailure,
} from "@/lib/developer-webhooks";
import { canUseInfra } from "@/lib/infra-access";
import type { ActionFailure } from "@/lib/infra-action-result";

export type InfraWebhookFailure = ActionFailure & {
	status: WebhookFailure["status"] | 429;
	code: string;
	hint: string | null;
};

const refuse = (
	status: InfraWebhookFailure["status"],
	code: string,
	message: string,
	hint: string | null = null,
): InfraWebhookFailure => ({ success: false, status, code, message, hint });

const fromLibrary = (failure: WebhookFailure) =>
	refuse(failure.status, failure.code, failure.message, failure.hint);

const appNotFound = () =>
	refuse(
		404,
		"app_not_found",
		"App not found",
		"Check that the app exists and belongs to your account.",
	);

const webhookNotFound = () =>
	refuse(
		404,
		"webhook_not_found",
		"Webhook endpoint not found",
		"Check the endpoint ID and that it belongs to this app. Deleted endpoints are not returned.",
	);

type Access =
	| { ok: true; appId: string }
	| { ok: false; failure: InfraWebhookFailure };

// Same scope as the REST API, which resolves the app from its secret key: an
// app the signed-in user owns and has not deleted. Anything else is a 404, so
// another account's app ID reveals nothing.
async function ownedApp(appId: unknown): Promise<Access> {
	const user = await getCurrentUser();
	if (!user || !canUseInfra(user.email)) throw new Error("Unauthorized");
	if (typeof appId !== "string" || appId === "") {
		return { ok: false, failure: appNotFound() };
	}

	const [app] = await db()
		.select({ id: developerApps.id })
		.from(developerApps)
		.where(
			and(
				eq(developerApps.id, appId),
				eq(developerApps.ownerId, user.id),
				isNull(developerApps.deletedAt),
			),
		)
		.limit(1);
	if (!app) return { ok: false, failure: appNotFound() };

	if (await developerConsoleRequestLimited(user.id)) {
		return {
			ok: false,
			failure: refuse(429, "rate_limited", DEVELOPER_CONSOLE_RATE_MESSAGE),
		};
	}
	return { ok: true, appId: app.id };
}

const validEndpointId = (value: unknown): value is string =>
	typeof value === "string" && value !== "";

const refresh = () => revalidatePath("/dashboard/infra", "layout");

export async function createInfraWebhook(
	appId: string,
	input: { url: string; events: string[] },
) {
	const access = await ownedApp(appId);
	if (!access.ok) return access.failure;

	const parsed = createWebhookEndpointInput.safeParse({
		url: input?.url,
		events: input?.events,
	});
	if (!parsed.success) {
		return refuse(
			400,
			"invalid_request",
			parsed.error.issues[0]?.message ?? "Invalid request",
		);
	}

	const result = await createWebhookEndpoint(access.appId, parsed.data);
	if (!result.ok) return fromLibrary(result);
	refresh();
	return {
		success: true as const,
		endpoint: serializeWebhookEndpoint(result.endpoint),
		secret: result.secret,
	};
}

export async function setInfraWebhookEnabled(
	appId: string,
	endpointId: string,
	enabled: boolean,
) {
	const access = await ownedApp(appId);
	if (!access.ok) return access.failure;
	if (!validEndpointId(endpointId)) return webhookNotFound();

	const parsed = updateWebhookEndpointInput.safeParse({ enabled });
	if (!parsed.success) {
		return refuse(
			400,
			"invalid_request",
			parsed.error.issues[0]?.message ?? "Invalid request",
		);
	}

	const result = await updateWebhookEndpoint(
		access.appId,
		endpointId,
		parsed.data,
	);
	if (!result.ok) return fromLibrary(result);
	refresh();
	return {
		success: true as const,
		endpoint: serializeWebhookEndpoint(result.endpoint),
	};
}

export async function rotateInfraWebhookSecret(
	appId: string,
	endpointId: string,
) {
	const access = await ownedApp(appId);
	if (!access.ok) return access.failure;
	if (!validEndpointId(endpointId)) return webhookNotFound();

	const result = await rotateWebhookEndpointSecret(access.appId, endpointId);
	if (!result.ok) return fromLibrary(result);
	refresh();
	return {
		success: true as const,
		endpoint: serializeWebhookEndpoint(result.endpoint),
		secret: result.secret,
	};
}

export async function deleteInfraWebhook(appId: string, endpointId: string) {
	const access = await ownedApp(appId);
	if (!access.ok) return access.failure;
	if (!validEndpointId(endpointId)) return webhookNotFound();

	const result = await deleteWebhookEndpoint(access.appId, endpointId);
	if (!result.ok) return fromLibrary(result);
	refresh();
	return { success: true as const };
}

export async function sendInfraWebhookTest(appId: string, endpointId: string) {
	const access = await ownedApp(appId);
	if (!access.ok) return access.failure;
	if (!validEndpointId(endpointId)) return webhookNotFound();

	const result = await sendWebhookTestEvent(access.appId, endpointId);
	if (!result.ok) return fromLibrary(result);
	refresh();
	return {
		success: true as const,
		test: serializeWebhookTestResult(result.eventId, result.result),
	};
}
